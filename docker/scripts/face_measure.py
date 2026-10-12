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

# 归一化人脸裁剪尺寸：Laplacian 方差对 bbox 大小极其敏感，先 resize 到固定尺寸再算，
# 数值才能跨景别/跨镜头可比，阈值也才有全局意义。
FACE_CROP_RESIZE = 96

# 关键帧清晰度门槛（单位：归一化到 FACE_CROP_RESIZE 后的灰度 Laplacian 方差）
KF_ABS_FLOOR = float(os.environ.get('KF_ABS_FLOOR', '60'))      # 绝对兜底线：低于=严重模糊，直接淘汰
KF_MEDIAN = float(os.environ.get('KF_MEDIAN', '150'))           # 内置任务中位数（打点校准后固化）
KF_REL_RATIO = float(os.environ.get('KF_REL_RATIO', '0.25'))    # 相对比例：usable_floor = max(abs, median*ratio)
KF_SHARP_TOL = float(os.environ.get('KF_SHARP_TOL', '30'))      # 非边界候选必须 >= 边界+该值 才允许换
KF_ADAPTIVE = os.environ.get('KF_ADAPTIVE', '1') == '1'         # 默认开：用当次全片 sharp_n 中位数自校准门槛
KF_PROBE = os.environ.get('KF_PROBE_SHARPNESS', '0') == '1'     # 1=额外写 sharpness_stats.json；分布日志始终打
KF_VERBOSE = os.environ.get('KF_VERBOSE', '0') == '1'           # 1=逐候选打印 sharp_n/eligible


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
    try:
        region = cv2.resize(region, (FACE_CROP_RESIZE, FACE_CROP_RESIZE),
                            interpolation=cv2.INTER_AREA)
    except Exception:
        return 0.0
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


def pct(values, p):
    """线性插值分位数（等价 numpy.percentile 默认算法）；不依赖 numpy。"""
    if not values:
        return 0.0
    v = sorted(values)
    if len(v) == 1:
        return float(v[0])
    k = (len(v) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    frac = k - lo
    return float(v[lo] * (1.0 - frac) + v[hi] * frac)


def sharpness_stats(values, write_json=False):
    """从已收集的归一化 sharp_n 列表计算分布并写统计。

    注意：values 必须来自 main() 阶段一缓存的人脸检测结果，
    不再独立跑一遍 detect_faces（避免 CROP 阶段检测耗时翻倍）。
    返回 {'n','min','p25','median','p75','max'}；无脸返回 None。
    """
    if not values:
        log("Sharpness probe: no faces detected across all shots")
        return None
    stats = {
        'n': len(values),
        'min': round(min(values), 1),
        'p25': round(pct(values, 25), 1),
        'median': round(pct(values, 50), 1),
        'p75': round(pct(values, 75), 1),
        'max': round(max(values), 1),
    }
    log(f"Sharpness probe: n={stats['n']}, min={stats['min']}, p25={stats['p25']}, "
        f"median={stats['median']}, p75={stats['p75']}, max={stats['max']}")
    if write_json:
        try:
            path = os.path.join(WORK_DIR, 'sharpness_stats.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(stats, f, ensure_ascii=False, indent=2)
            log(f"Sharpness stats saved to {path}")
        except Exception as e:
            log(f"Sharpness stats write failed: {e}")
    return stats


def choose_keyframe_sources(shot_index, present, sample_keys, times, frame_faces, tracks,
                            anchor_roles, usable_floor):
    """首/尾帧锚点化：在靠近首/尾的候选帧里，优先选「本镜关键角色脸在且最清晰」的帧。

    新规则（相对历史版的修复）：
      - 归一化清晰度 >= usable_floor 才算 eligible（绝对兜底 + 任务相对中位线）；
      - 非边界候选必须比边界帧显著更清晰（>= boundary + KF_SHARP_TOL）才允许换，
        杜绝过渡/运动模糊帧顶替边界（如 shot57 20% 帧）；
      - 该侧没有任何 eligible 候选时回退边界帧，绝不从一堆模糊帧里挑最不差的；
      - 距离按镜长归一化后仅作同分偏好，不再压制清晰度。

    返回 dict，每侧为 (best_idx, best_role_face, best_sharp, reason)，
    reason ∈ {'non_boundary', 'kept_boundary', 'fallback'}。
    """
    def score(idx):
        img_path = os.path.join(FRAMES_DIR, frame_name(shot_index, sample_keys[idx]))
        img = cv2.imread(img_path) if os.path.exists(img_path) else None
        if img is None:
            return None, -1.0, 0.0, False
        role_face = role_face_at_idx(present, tracks, frame_faces, sample_keys, idx)
        anchor_count = sum(1 for r in anchor_roles if r in role_face)
        if anchor_count == 0:
            if KF_VERBOSE:
                log(f"    kf cand idx={idx} ({frame_name(shot_index, sample_keys[idx])}): no anchor face")
            return role_face, -1.0, 0.0, False
        sharp = []
        for r in anchor_roles:
            f = role_face.get(r)
            if f is not None:
                sharp.append(face_sharpness(img, f))
        mean_sh = sum(sharp) / len(sharp) if sharp else 0.0
        eligible = mean_sh >= usable_floor
        if KF_VERBOSE:
            log(f"    kf cand idx={idx} ({frame_name(shot_index, sample_keys[idx])}): "
                f"sharp={mean_sh:.1f} eligible={eligible} (floor={usable_floor:.1f})")
        if not eligible:
            return role_face, -1.0, mean_sh, eligible
        boundary = 0 if idx <= 4 else 10
        # 距离按镜长归一化：长镜里 raw 秒数会淹没清晰度项，导致非边界候选永远选不上
        span = abs(times[sample_keys[10]] - times[sample_keys[0]])
        dist = abs(times[sample_keys[idx]] - times[sample_keys[boundary]])
        dist_n = dist / span if span > 1e-6 else 0.0
        # DIST_W 必须小于 KF_SHARP_TOL/300（≈0.1），否则「通过显著性门槛」的候选
        # 会被距离惩罚反噬——距离项只能当同分偏好，不能否决清晰度结论
        return role_face, anchor_count * 10.0 + mean_sh / 300.0 - dist_n * 0.05, mean_sh, eligible

    out = {}
    for label, cands, boundary in (('first', [0, 1, 2, 3, 4], 0), ('last', [6, 7, 8, 9, 10], 10)):
        best_idx = boundary
        best_score = -1.0
        # 边界帧清晰度（不论是否 eligible，都作为「必须显著更清晰」的基准）
        b_role_face, _b_sc, boundary_sharp, b_eligible = score(boundary)
        best_role_face = b_role_face if b_role_face is not None else {}
        best_sharp = boundary_sharp
        picked = False
        for idx in cands:
            role_face, sc, sh, eligible = score(idx)
            if role_face is None or not eligible:
                continue
            # 显著性门槛：非边界候选必须比边界帧清晰 KF_SHARP_TOL 以上才允许换，
            # 放在打分之前，保证「同分偏好边界」不被距离惩罚项稀释成死规则
            if idx != boundary and sh < boundary_sharp + KF_SHARP_TOL:
                if KF_VERBOSE:
                    log(f"    kf {label}: skip idx={idx} (sharp {sh:.1f} < boundary "
                        f"{boundary_sharp:.1f} + tol {KF_SHARP_TOL})")
                continue
            if sc > best_score:
                best_score = sc
                best_idx = idx
                best_role_face = role_face
                best_sharp = sh
                picked = True
        if not picked:
            reason = 'kept_boundary' if b_eligible else 'fallback'
        elif best_idx != boundary:
            reason = 'non_boundary'
        else:
            reason = 'kept_boundary'
        out[label] = (best_idx, best_role_face, best_sharp, reason)
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

    # ── 阶段一：全片检测 + 追踪 + 角色分配 + refine ──
    # 缓存每镜候选帧的检测结果与人脸清晰度，供阶段二中位数门槛直接复用，
    # 避免独立 probe 再跑一遍 detect_faces（不再有第二次检测 pass 的耗时）。
    sharp_values = []
    prepared = []

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
            if img is None:
                frame_faces.append([])
                continue
            dets = detect_faces(app, img)
            frame_faces.append(dets)
            for f in dets:
                sharp_values.append(face_sharpness(img, f))

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

        # 关键帧锚点化：锚定说话人（无台词则用出场角色）
        speaking_roles = []
        for d in (shot.get('dialogues') or []):
            sp = d.get('speaker')
            if sp and sp != 'NARRATOR' and sp != 'null' and sp not in speaking_roles:
                speaking_roles.append(sp)
        anchor_roles = speaking_roles if speaking_roles else present

        prepared.append({
            'i': i, 'shot': shot, 'present': present, 'times': times,
            'frame_faces': frame_faces, 'tracks': tracks,
            'assignments': assignments, 'anchor_roles': anchor_roles,
        })

    # ── 关键帧清晰度门槛：绝对兜底 + 任务相对中位线（复用阶段一缓存，无额外检测）──
    stats = sharpness_stats(sharp_values, write_json=KF_PROBE)
    median_task = (stats['median'] if stats is not None else None) if KF_ADAPTIVE else (KF_MEDIAN if KF_MEDIAN > 0 else None)
    usable_floor = max(KF_ABS_FLOOR, median_task * KF_REL_RATIO) if median_task is not None else KF_ABS_FLOOR
    median_txt = f"{median_task:.1f}" if median_task is not None else "n/a"
    log(f"Keyframe sharpness: abs_floor={KF_ABS_FLOOR}, rel_ratio={KF_REL_RATIO}, "
        f"median={median_txt}, usable_floor={usable_floor:.1f}, tol={KF_SHARP_TOL}")

    kf_boundary_kept = 0
    kf_non_boundary = 0
    kf_fallback = 0

    # ── 阶段二：基于全局门槛选关键帧 + 回填坐标/可见性/一致性 ──
    for item in prepared:
        i = item['i']
        shot = item['shot']
        present = item['present']
        times = item['times']
        frame_faces = item['frame_faces']
        tracks = item['tracks']
        assignments = item['assignments']
        anchor_roles = item['anchor_roles']

        try:
            sources = choose_keyframe_sources(i, present, sample_keys, times, frame_faces, tracks, anchor_roles, usable_floor)
            first_idx, _, first_sharp, first_reason = sources['first']
            last_idx, _, last_sharp, last_reason = sources['last']
        except Exception as e:
            log(f"  Shot {i}: choose_keyframe_sources failed, keeping boundary frames: {e}")
            first_idx, last_idx = 0, 10
            first_sharp = last_sharp = 0.0
            first_reason = last_reason = 'fallback'
        shot['first_keyframe_source'] = first_idx
        shot['last_keyframe_source'] = last_idx

        for reason in (first_reason, last_reason):
            if reason == 'fallback':
                kf_fallback += 1
            elif reason == 'non_boundary':
                kf_non_boundary += 1
            else:
                kf_boundary_kept += 1

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
        log(f"  Shot {i}: roles={present}, anchors={anchor_roles}, "
            f"first_src={first_idx}(sh={first_sharp:.1f},{first_reason}), "
            f"last_src={last_idx}(sh={last_sharp:.1f},{last_reason}), "
            f"assigned={len(assignments)}, visible={sorted(measured_visible)}, "
            f"speakers={speakers}, use_source_audio={use_source_audio}")

    log(f"Keyframe summary: boundary_kept={kf_boundary_kept}, non_boundary={kf_non_boundary}, fallback={kf_fallback}")

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
