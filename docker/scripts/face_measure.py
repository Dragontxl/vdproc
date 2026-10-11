#!/usr/bin/env python3
import os
import sys
import json
import time
import subprocess

try:
    import cv2
    import numpy as np
    from insightface.app import FaceAnalysis

    def make_app():
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=-1, det_size=(640, 640))
        return app

    FACE_SDK_OK = True
except Exception:
    FACE_SDK_OK = False
    import traceback
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] insightface/cv2/numpy import failed: {traceback.format_exc()}", flush=True)

TASK_ID = os.environ.get('TASK_ID', '')
WORK_DIR = f"/tmp/{TASK_ID}"
ANALYSIS_PATH = os.path.join(WORK_DIR, 'analysis_result.json')
VIDEO_PATH = os.path.join(WORK_DIR, 'input_video.mp4')
FRAMES_DIR = os.path.join(WORK_DIR, 'shot_frames')
OUT_PATH = os.path.join(WORK_DIR, 'analysis_result.json.measured')

MATCH_SIM = 0.35
TRACK_SIM = 0.50
MIN_DET_SCORE = 0.5
MIN_FACE_W = 24


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def parse_tc(tc):
    parts = tc.split(':')
    h = int(parts[0])
    m = int(parts[1])
    s = float(parts[2])
    return h * 3600 + m * 60 + s


def sec_to_tc(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def frame_times(start_sec, end_sec):
    dur = end_sec - start_sec
    times = {'first': start_sec + 0.150 if start_sec + 0.150 < end_sec - 0.150 else start_sec}
    for n in range(1, 10):
        t = start_sec + dur * n / 10.0
        times[str(n)] = min(max(t, start_sec), end_sec)
    times['last'] = end_sec - 0.150 if end_sec - 0.150 > start_sec + 0.150 else end_sec
    return times


def frame_name(i, key):
    if key == 'first':
        return f"shot_{i}_first.jpg"
    if key == 'last':
        return f"shot_{i}_last.jpg"
    return f"shot_{i}_1-{key}.jpg"


def ffmpeg_extract(time_sec, out_path):
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-v', 'error', '-ss', sec_to_tc(time_sec),
             '-i', VIDEO_PATH, '-frames:v', '1', '-q:v', '2', out_path],
            check=True, capture_output=True, timeout=60)
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception as e:
        log(f"ffmpeg extraction failed at {sec_to_tc(time_sec)}: {e}")
        return False


def detect_faces(app, image):
    if image is None:
        return []
    h, w = image.shape[:2]
    faces = []
    try:
        dets = app.get(image)
    except Exception as e:
        log(f"Face detection error: {e}")
        return []
    for f in dets:
        x1, y1, x2, y2 = [int(v) for v in f.bbox]
        bw = x2 - x1
        bh = y2 - y1
        if bw < MIN_FACE_W:
            continue
        score = float(f.det_score)
        if score < MIN_DET_SCORE:
            continue
        emb = np.asarray(f.embedding, dtype=np.float64) if getattr(f, 'embedding', None) is not None else None
        faces.append({
            'bbox': [x1, y1, x2, y2],
            'score': score,
            'emb': emb,
            'cx': (x1 + x2) / 2.0 / w,
            'cy': (y1 + y2) / 2.0 / h,
            'area': float(bw * bh),
        })
    return faces


def iou(a, b):
    ax1, ay1, ax2, ay2 = a['bbox']
    bx1, by1, bx2, by2 = b['bbox']
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    aa = (ax2 - ax1) * (ay2 - ay1)
    ba = (bx2 - bx1) * (by2 - by1)
    union = aa + ba - inter
    return inter / union if union > 0 else 0.0


def cos_sim(a, b):
    if a is None or b is None:
        return 0.0
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def mean_emb(refs):
    if not refs:
        return None
    return np.mean(refs, axis=0)


def face_sharpness(img, face):
    if img is None:
        return 0.0
    x1, y1, x2, y2 = face['bbox']
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(img.shape[1], x2)
    y2 = min(img.shape[0], y2)
    if x2 - x1 < 8 or y2 - y1 < 8:
        return 0.0
    region = img[y1:y2, x1:x2]
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def role_face_at_idx(present, tracks, frame_faces, sample_keys, idx):
    key = sample_keys[idx]
    dets = frame_faces[idx]
    role_face = {}
    for role in present:
        for tr in tracks:
            if tr.get('role') != role:
                continue
            for entry in tr['faces']:
                if sample_keys[entry['frame_idx']] == key:
                    role_face[role] = entry['face']
                    break
            if role in role_face:
                break
        if role not in role_face and len(present) == 1 and len(dets) == 1:
            role_face[role] = dets[0]
    return role_face


def choose_keyframe_sources(shot_index, present, sample_keys, times, frame_faces, tracks, anchor_roles):
    # 首/尾帧锚点化：在靠近首/尾的候选帧里，优先选「本镜关键角色脸在且最清晰」的帧，
    # 避免固定 ±0.150s 抽到模糊/闭眼/缺脸帧导致动画形象崩坏。
    # 距离惩罚让同分时尽量贴近边界，保持镜头首尾语义。
    def score(idx):
        img_path = os.path.join(FRAMES_DIR, frame_name(shot_index, sample_keys[idx]))
        img = cv2.imread(img_path) if os.path.exists(img_path) else None
        if img is None:
            return None, -1.0
        role_face = role_face_at_idx(present, tracks, frame_faces, sample_keys, idx)
        anchor_count = sum(1 for r in anchor_roles if r in role_face)
        if anchor_count == 0:
            return role_face, -1.0
        sharp = []
        for r in anchor_roles:
            f = role_face.get(r)
            if f is not None:
                sharp.append(face_sharpness(img, f))
        mean_sh = sum(sharp) / len(sharp) if sharp else 0.0
        boundary = 0 if idx <= 4 else 10
        dist = abs(times[sample_keys[idx]] - times[sample_keys[boundary]])
        return role_face, anchor_count * 10.0 + mean_sh / 500.0 - dist * 8.0

    out = {}
    for label, cands, boundary in (('first', [0, 1, 2, 3, 4], 0), ('last', [6, 7, 8, 9, 10], 10)):
        best_idx = boundary
        best_score = -1.0
        best_role_face = {}
        for idx in cands:
            role_face, sc = score(idx)
            if role_face is None:
                continue
            if sc > best_score:
                best_score = sc
                best_idx = idx
                best_role_face = role_face
        out[label] = (best_idx, best_role_face)
    return out


def build_tracks(frame_faces):
    tracks = []
    for fi, faces in enumerate(frame_faces):
        for face in faces:
            best_tr = None
            best_score = 0.0
            for tr in tracks:
                last_idx = tr['faces'][-1]['frame_idx']
                if last_idx < fi - 2:
                    continue
                prev = tr['faces'][-1]['face']
                iou_v = iou(prev, face)
                sim = cos_sim(prev['emb'], face['emb'])
                if iou_v >= 0.2:
                    s = iou_v
                elif sim >= TRACK_SIM:
                    s = 0.5 + sim * 0.5
                else:
                    continue
                if s > best_score:
                    best_score = s
                    best_tr = tr
            if best_tr is not None:
                best_tr['faces'].append({'frame_idx': fi, 'face': face})
            else:
                tracks.append({'faces': [{'frame_idx': fi, 'face': face}], 'role': None})
    for tr in tracks:
        best = max(tr['faces'], key=lambda x: x['face']['score'] * x['face']['area'])
        tr['best'] = best
        tr['quality'] = best['face']['score'] * best['face']['area']
    return tracks


def assign_tracks(present, tracks, role_refs):
    assignments = {}
    unassigned_roles = list(present)

    if len(present) == 1 and len(tracks) >= 1:
        best = max(tracks, key=lambda t: t['quality'])
        assignments[present[0]] = best
        best['role'] = present[0]
        role_refs.setdefault(present[0], []).append(best['best']['face']['emb'])
        return assignments

    for track in sorted([t for t in tracks if t['role'] is None], key=lambda t: t['quality'], reverse=True):
        if track['role'] is not None:
            continue
        best_role = None
        best_sim = MATCH_SIM
        track_emb = track['best']['face']['emb']
        for role in unassigned_roles:
            refs = role_refs.get(role)
            if not refs:
                continue
            sim = cos_sim(track_emb, mean_emb(refs))
            if sim > best_sim:
                best_sim = sim
                best_role = role
        if best_role is not None:
            assignments[best_role] = track
            track['role'] = best_role
            unassigned_roles.remove(best_role)
            role_refs[best_role].append(track_emb)

    remaining = [t for t in tracks if t['role'] is None]
    if len(unassigned_roles) == 1 and len(remaining) == 1:
        role = unassigned_roles[0]
        tr = remaining[0]
        assignments[role] = tr
        tr['role'] = role
        role_refs.setdefault(role, []).append(tr['best']['face']['emb'])

    return assignments


def refine_best(app, role, t0, start_sec, end_sec, role_refs):
    step = (end_sec - start_sec) / 10.0
    if step <= 0:
        return None, None, None
    candidates = []
    tmp_path = os.path.join(WORK_DIR, f"_refine_{role}.jpg")
    for off in (-step, 0.0, step):
        t = max(start_sec + 0.1, min(end_sec - 0.1, t0 + off))
        if not ffmpeg_extract(t, tmp_path):
            continue
        img = cv2.imread(tmp_path)
        faces = detect_faces(app, img)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if not faces:
            continue
        chosen = None
        if len(faces) == 1:
            chosen = faces[0]
        else:
            refs = role_refs.get(role)
            if refs:
                m = mean_emb(refs)
                best = max(faces, key=lambda f: cos_sim(f['emb'], m))
                if cos_sim(best['emb'], m) >= MATCH_SIM:
                    chosen = best
        if chosen is not None:
            candidates.append((chosen['score'] * chosen['area'], t, chosen['cx'], chosen['cy']))
    if candidates:
        _, t, cx, cy = max(candidates)
        return t, cx, cy
    return None, None, None


def main():
    if not TASK_ID:
        log("TASK_ID not set, skipping face measurement")
        return 0

    if not os.path.exists(ANALYSIS_PATH):
        log(f"analysis_result.json not found at {ANALYSIS_PATH}, skipping")
        return 0

    if not os.path.exists(FRAMES_DIR):
        log(f"shot_frames dir not found at {FRAMES_DIR}, skipping")
        return 0

    if not FACE_SDK_OK:
        log("insightface SDK unavailable, skipping face measurement")
        return 0

    app = make_app()

    log("Face measurement started")
    with open(ANALYSIS_PATH, 'r', encoding='utf-8') as f:
        result = json.load(f)

    storyboards = result.get('storyboards', [])
    characters = result.get('characters', [])
    if not storyboards:
        log("No storyboards, skipping")
        return 0

    role_refs = {}
    role_best = {}
    measured_shots = 0
    missing_roles = {}

    sample_keys = ['first'] + [str(n) for n in range(1, 10)] + ['last']

    for i, shot in enumerate(storyboards):
        start_sec = parse_tc(shot.get('start_time', '00:00:00.000'))
        end_sec = parse_tc(shot.get('end_time', '00:00:00.000'))
        if end_sec <= start_sec:
            log(f"  Shot {i}: invalid time range, skipping")
            continue

        present = []
        for role in (shot.get('characters_present') or []):
            if role and role != 'NARRATOR' and role not in present:
                present.append(role)
        for d in (shot.get('dialogues') or []):
            sp = d.get('speaker')
            if sp and sp != 'NARRATOR' and sp != 'null' and sp not in present:
                present.append(sp)
        if not present:
            continue

        times = frame_times(start_sec, end_sec)
        frame_faces = []
        for key in sample_keys:
            path = os.path.join(FRAMES_DIR, frame_name(i, key))
            img = cv2.imread(path) if os.path.exists(path) else None
            frame_faces.append(detect_faces(app, img))

        tracks = []
        assignments = {}
        try:
            tracks = build_tracks(frame_faces)
            assignments = assign_tracks(present, tracks, role_refs)
        except Exception as e:
            log(f"  Shot {i}: face tracking failed: {e}")
            continue
        if not assignments:
            log(f"  Shot {i}: no face assignment for roles {present}")
            continue

        for role, tr in assignments.items():
            best_face = tr['best']['face']
            bf_time = times[sample_keys[tr['best']['frame_idx']]]
            quality = tr['quality']
            try:
                refined_t, rx, ry = refine_best(app, role, bf_time, start_sec, end_sec, role_refs)
            except Exception as e:
                log(f"  Shot {i}: refine_best failed for {role}: {e}")
                refined_t, rx, ry = None, None, None
            cur = role_best.get(role)
            if refined_t is not None and rx is not None:
                if cur is None or quality >= cur['quality']:
                    role_best[role] = {'time': refined_t, 'cx': rx, 'cy': ry, 'quality': quality}
            else:
                if cur is None or quality > cur['quality']:
                    role_best[role] = {'time': bf_time, 'cx': best_face['cx'], 'cy': best_face['cy'], 'quality': quality}

        # 关键帧锚点化：为每个分镜选定首/尾帧的最佳候选源帧
        speaking_roles = []
        for d in (shot.get('dialogues') or []):
            sp = d.get('speaker')
            if sp and sp != 'NARRATOR' and sp != 'null' and sp not in speaking_roles:
                speaking_roles.append(sp)
        anchor_roles = speaking_roles if speaking_roles else present

        try:
            sources = choose_keyframe_sources(i, present, sample_keys, times, frame_faces, tracks, anchor_roles)
            first_idx, _ = sources['first']
            last_idx, _ = sources['last']
        except Exception as e:
            log(f"  Shot {i}: choose_keyframe_sources failed, keeping boundary frames: {e}")
            first_idx, last_idx = 0, 10
        shot['first_keyframe_source'] = first_idx
        shot['last_keyframe_source'] = last_idx

        try:
            for key, idx in (('first', first_idx), ('last', last_idx)):
                role_face = role_face_at_idx(present, tracks, frame_faces, sample_keys, idx)
                measured = []
                for role in present:
                    face = role_face.get(role)
                    if face is not None:
                        measured.append({'role_id': role, 'x': round(float(face['cx']), 4), 'y': round(float(face['cy']), 4)})
                shot['first_keyframe_characters' if key == 'first' else 'last_keyframe_characters'] = measured
        except Exception as e:
            log(f"  Shot {i}: keyframe coordinate backfill failed: {e}")

        # 判定本镜是否为"纯画外音镜头"：说话人（含旁白）都不在关键帧可见角色里。
        # 这类镜头台词置空、不生成口型，改由合成阶段叠加原视频原声。
        first_kc = shot.get('first_keyframe_characters') or []
        last_kc = shot.get('last_keyframe_characters') or []
        measured_visible = set()
        for kc in first_kc + last_kc:
            r = kc.get('role_id')
            if r:
                measured_visible.add(r)
        speakers = []
        for d in (shot.get('dialogues') or []):
            sp = d.get('speaker')
            if sp and sp != 'null':
                speakers.append(sp)
        on_screen = [s for s in speakers if s in measured_visible]
        use_source_audio = bool(first_kc or last_kc) and bool(speakers) and len(on_screen) == 0
        shot['use_source_audio'] = use_source_audio

        # 一致性校验（只加字段，不改原字段，不影响画外音）：
        # 排除"有画外音台词解释"的正常不可见角色，只有"在 present、不可见、又无台词解释"才算可疑。
        present_roles = set(r for r in (shot.get('characters_present') or []) if r and r != 'NARRATOR')
        dialogue_speakers = set(s for s in speakers if s and s != 'NARRATOR')
        unexplained = [r for r in present_roles if r not in measured_visible and r not in dialogue_speakers]
        suspect = bool(measured_visible) and len(unexplained) > 0
        shot['measured_visible_characters'] = sorted(measured_visible)
        shot['character_consistency'] = 'suspect' if suspect else 'ok'
        if suspect:
            shot['consistency_notes'] = f"present={sorted(present_roles)} measured_visible={sorted(measured_visible)} unexplained={unexplained}"

        measured_shots += 1
        log(f"  Shot {i}: roles={present}, anchors={anchor_roles}, first_src={first_idx}, last_src={last_idx}, assigned={len(assignments)}, visible={sorted(measured_visible)}, speakers={speakers}, use_source_audio={use_source_audio}")

    log("Backfilling measured values into characters")
    for ch in characters:
        role = ch.get('role_id')
        info = role_best.get(role)
        if info:
            ch['best_face_time'] = sec_to_tc(info['time'])
            ch['face_position_x'] = round(float(info['cx']), 4)
            ch['face_position_y'] = round(float(info['cy']), 4)
        else:
            missing_roles[role] = ch.get('name', role)
            ch['best_face_time'] = None
            ch['face_position_x'] = None
            ch['face_position_y'] = None

    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(OUT_PATH, ANALYSIS_PATH)
    log(f"Face measurement complete: {measured_shots}/{len(storyboards)} shots measured")
    if missing_roles:
        log(f"Roles without measured faces: {missing_roles}")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        import traceback
        log(f"Face measurement failed: {e}")
        log(traceback.format_exc())
        sys.exit(1)
