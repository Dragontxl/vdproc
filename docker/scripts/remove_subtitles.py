#!/usr/bin/env python3
"""去除抽帧图字幕：
  1) 底部 SUBTITLE_BAND_RATIO 区域内用 OpenCV EAST (cv2.dnn) 检测文字 bbox；
  2) 只对检测到的字幕框做 cv2.inpaint；
  3) 该帧底部无检测到文字 -> 跳过不修（避免误伤）；
  4) EAST 模型缺失/不可用时，回退为"固定底部条带 inpaint"。

运行于 CROP_SHOTS 抽帧后、face_measure 之前。
"""
import os
import sys
import glob
import math

try:
    import cv2
    import numpy as np
    CV_OK = True
except Exception as e:  # noqa: BLE001
    CV_OK = False
    print(f"[remove_subtitles] cv2/numpy 不可用，跳过: {e}", flush=True)

TASK_ID = os.environ.get('TASK_ID', '')
WORK_DIR = f"/tmp/{TASK_ID}"
FRAMES_DIR = os.path.join(WORK_DIR, 'shot_frames')

EAST_PATH = os.environ.get('EAST_MODEL_PATH', '/opt/east/frozen_east_text_detection.pb')
CONF_THRESH = float(os.environ.get('EAST_CONF_THRESH', '0.5'))
NMS_THRESH = float(os.environ.get('EAST_NMS_THRESH', '0.4'))
PAD = int(os.environ.get('SUBTITLE_PAD', '3'))

_net = None
_net_tried = False


def load_net():
    global _net, _net_tried
    if _net_tried:
        return _net
    _net_tried = True
    if not (CV_OK and os.path.exists(EAST_PATH)):
        print(f"[remove_subtitles] EAST 模型不存在（{EAST_PATH}），将回退固定条带", flush=True)
        return None
    try:
        _net = cv2.dnn.readNet(EAST_PATH)
        print(f"[remove_subtitles] EAST 模型已加载: {EAST_PATH}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[remove_subtitles] EAST 模型加载失败，回退固定条带: {e}", flush=True)
        _net = None
    return _net


def decode_east(scores, geo, conf):
    num_rows, num_cols = scores.shape[2:4]
    rects, confs = [], []
    for y in range(num_rows):
        s = scores[0, 0, y]
        x0 = geo[0, 0, y]
        x1 = geo[0, 1, y]
        x2 = geo[0, 2, y]
        x3 = geo[0, 3, y]
        angles = geo[0, 4, y]
        for x in range(num_cols):
            if s[x] < conf:
                continue
            off_x = x * 4.0
            off_y = y * 4.0
            angle = angles[x]
            cos = math.cos(angle)
            sin = math.sin(angle)
            h = x0[x] + x2[x]
            w = x1[x] + x3[x]
            end_x = off_x + cos * x1[x] + sin * x2[x]
            end_y = off_y - sin * x1[x] + cos * x2[x]
            start_x = end_x - w
            start_y = end_y - h
            rects.append([float(start_x), float(start_y), float(w), float(h)])
            confs.append(float(s[x]))
    return rects, confs


def detect_boxes(roi):
    net = load_net()
    if net is None or roi is None:
        return []
    h, w = roi.shape[:2]
    new_w = max(32, (w // 32) * 32)
    new_h = max(32, (h // 32) * 32)
    blob = cv2.dnn.blobFromImage(
        roi, 1.0, (new_w, new_h), (123.68, 116.78, 103.94), swapRB=True, crop=False)
    net.setInput(blob)
    scores, geo = net.forward([
        "feature_fusion/Conv_7/Sigmoid",
        "feature_fusion/concat_3",
    ])
    rects, confs = decode_east(scores, geo, CONF_THRESH)
    if not rects:
        return []
    idxs = cv2.dnn.NMSBoxes(rects, confs, CONF_THRESH, NMS_THRESH)
    if len(idxs) == 0:
        return []
    rx = w / float(new_w)
    ry = h / float(new_h)
    boxes = []
    for i in np.array(idxs).flatten():
        x, y, bw, bh = rects[i]
        boxes.append((int(x * rx), int(y * ry), int(bw * rx), int(bh * ry)))
    return boxes


def main():
    if not CV_OK:
        return 0
    if not os.path.isdir(FRAMES_DIR):
        print(f"[remove_subtitles] 未找到 {FRAMES_DIR}，跳过")
        return 0

    try:
        band = float(os.environ.get('SUBTITLE_BAND_RATIO', '0.14'))
    except ValueError:
        band = 0.14
    band = max(0.0, min(0.5, band))
    try:
        radius = int(os.environ.get('INPAINT_RADIUS', '3'))
    except ValueError:
        radius = 3

    east_on = load_net() is not None
    print(f"[remove_subtitles] EAST={'on' if east_on else 'off(固定条带回退)'}, band={band:.2f}, radius={radius}")

    files = sorted(glob.glob(os.path.join(FRAMES_DIR, '*.jpg')))
    done = 0
    skipped = 0
    for path in files:
        img = cv2.imread(path)
        if img is None:
            continue
        h, w = img.shape[:2]
        y0 = int(h * (1.0 - band))
        if band <= 0 or y0 >= h:
            continue
        mask = np.zeros((h, w), np.uint8)

        if east_on:
            roi = img[y0:h, :]
            boxes = detect_boxes(roi)
            if not boxes:
                skipped += 1
                continue
            for (bx, by, bw, bh) in boxes:
                x1 = max(0, bx - PAD)
                y1 = max(0, y0 + by - PAD)
                x2 = min(w, bx + bw + PAD)
                y2 = min(h, y0 + by + bh + PAD)
                mask[y1:y2, x1:x2] = 255
        else:
            mask[y0:h, :] = 255

        if mask.max() == 0:
            skipped += 1
            continue
        out = cv2.inpaint(img, mask, radius, cv2.INPAINT_TELEA)
        cv2.imwrite(path, out, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
        done += 1

    print(f"[remove_subtitles] 完成：修复 {done} 帧，跳过 {skipped} 帧（无字幕/无cv2）")
    return 0


if __name__ == '__main__':
    sys.exit(main())