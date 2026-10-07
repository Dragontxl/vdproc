#!/usr/bin/env python3
"""Agnes Video 2.5 Flash 接入测试脚本（仅标准库，无第三方依赖）。

用法示例：
  # 文生视频
  python3 test_agnes_video.py --api-key $AGNES_API_KEY \
      --mode text --prompt "一只橘猫在窗台上晒太阳，镜头缓慢推近" --seconds 5 --output cat.mp4

  # 首尾帧控制（本项目主要场景）
  python3 test_agnes_video.py --api-key $AGNES_API_KEY \
      --mode keyframe \
      --first-frame "https://example.com/first.png" \
      --last-frame  "https://example.com/last.png" \
      --prompt "人物自然转身走向窗边，固定机位，画面平滑过渡" \
      --seconds 5 --output demo.mp4

  # 图片参考
  python3 test_agnes_video.py --api-key $AGNES_API_KEY \
      --mode reference --images "https://example.com/char.png" \
      --prompt "以 <Picture 1> 的角色为参考，角色在花田奔跑，保持外观一致" \
      --seconds 5 --output ref.mp4

参数说明（对齐官方文档）：
  seconds  字符串 "4"–"12"，默认 "5"
  size     2.5-flash 固定 "720P"
  aspect_ratio  16:9 / 9:16 / 4:3 / 1:1 / 3:4 / 21:9，默认 16:9
  轮询     推荐 1–2 秒/次，必须带 model_name=agnes-video-2.5-flash
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MODEL_DEFAULT = "agnes-video-2.5-flash"
POLL_ENDPOINT = "/agnesapi"


def http_request(method, url, headers=None, body=None, timeout=60):
    """返回 (http_code, response_bytes)。网络异常时返回 (0, 错误信息)。"""
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # urlopen/read 超时、断连等
        return 0, str(e).encode("utf-8", errors="replace")


def build_payload(args):
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "mode": args.mode,
        "seconds": str(args.seconds),
        "size": args.size,
        "aspect_ratio": args.aspect_ratio,
        "n": 1,
    }
    if args.seed is not None:
        payload["seed"] = args.seed

    if args.mode == "keyframe":
        if args.first_frame:
            payload["first_frame"] = args.first_frame
        if args.last_frame:
            payload["last_frame"] = args.last_frame
        if not (args.first_frame or args.last_frame):
            sys.exit("keyframe 模式需要 --first-frame 和/或 --last-frame")
    elif args.mode == "reference":
        if args.images:
            payload["images"] = args.images
        if args.audios:
            payload["audios"] = args.audios
        if not (args.images or args.audios):
            sys.exit("reference 模式需要 --images 和/或 --audios")
    return payload


def create_task(args):
    url = args.base_url.rstrip("/") + "/videos"
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + args.api_key,
    }
    body = json.dumps(build_payload(args), ensure_ascii=False).encode("utf-8")
    print(f"[create] POST {url}")
    status, data = http_request("POST", url, headers, body, timeout=args.timeout)
    if status == 0:
        sys.exit(f"[create] 网络错误: {data.decode('utf-8', errors='replace')}")
    if status != 200:
        msg = data.decode("utf-8", errors="replace")[:500]
        sys.exit(f"[create] HTTP {status}: {msg}")
    resp = json.loads(data)
    video_id = resp.get("video_id") or resp.get("id") or resp.get("task_id")
    if not video_id:
        sys.exit(f"[create] 响应中没有 video_id: {json.dumps(resp, ensure_ascii=False)}")
    print(f"[create] 成功. video_id={video_id}, model={resp.get('model')}, seconds={resp.get('seconds')}, size={resp.get('size')}")
    return video_id


def poll_task(args, video_id):
    parsed = urllib.parse.urlparse(args.base_url)
    base_poll = f"{parsed.scheme}://{parsed.netloc}{POLL_ENDPOINT}"
    headers = {"Authorization": "Bearer " + args.api_key}
    max_polls = args.max_polls
    for i in range(1, max_polls + 1):
        qs = urllib.parse.urlencode({"video_id": video_id, "model_name": args.model})
        url = f"{base_poll}?{qs}"
        status, data = http_request("GET", url, headers, timeout=args.timeout)
        if status == 0:
            print(f"[poll {i}/{max_polls}] 网络错误: {data.decode('utf-8', errors='replace')}")
        elif status != 200:
            msg = data.decode("utf-8", errors="replace")[:500]
            print(f"[poll {i}/{max_polls}] HTTP {status}: {msg}")
        else:
            resp = json.loads(data)
            st = resp.get("status", "")
            progress = resp.get("progress", 0)
            print(f"[poll {i}/{max_polls}] status={st} progress={progress}%")
            if st == "completed":
                url = resp.get("url")
                if not url:
                    sys.exit("[poll] completed 但没有 url 字段")
                return url
            if st == "failed":
                err = resp.get("error") if isinstance(resp.get("error"), dict) else {"message": resp.get("error")}
                sys.exit(f"[poll] 任务失败: {err}")
        if i < max_polls:
            time.sleep(args.poll_interval)
    sys.exit(f"[poll] 超过 {max_polls} 次轮询未完成，请检查任务状态")


def download(url, output, timeout=120):
    print(f"[download] {url}")
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(output, "wb") as f:
            total = 0
            while True:
                chunk = resp.read(1024 * 512)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        print(f"[download] 完成，写入 {output}（{total} 字节）")
    except Exception as e:
        sys.exit(f"[download] 失败: {e}")


def main():
    parser = argparse.ArgumentParser(description="Agnes Video 2.5 Flash 测试脚本")
    parser.add_argument("--api-key", default=os.environ.get("AGNES_API_KEY", "").strip() or None, help="API Key（或环境变量 AGNES_API_KEY）")
    parser.add_argument("--base-url", default="https://apihub.agnes-ai.com/v1", help="API Base URL，默认官方公共地址")
    parser.add_argument("--model", default=MODEL_DEFAULT)
    parser.add_argument("--mode", choices=["text", "keyframe", "reference"], default="text")
    parser.add_argument("--prompt", default="一只橘猫坐在窗台上晒太阳，镜头缓慢平稳推近，电影质感", help="视频内容描述")
    parser.add_argument("--seconds", type=str, default="5", help="时长字符串 4-12，默认 5")
    parser.add_argument("--size", default="720P", help="2.5-flash 固定 720P")
    parser.add_argument("--aspect-ratio", default="16:9")
    parser.add_argument("--first-frame", default=None, help="keyframe 首帧 URL")
    parser.add_argument("--last-frame", default=None, help="keyframe 尾帧 URL")
    parser.add_argument("--images", default=None, help="reference 图片 URL，多个用逗号分隔")
    parser.add_argument("--audios", default=None, help="reference 音频 URL，多个用逗号分隔")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--output", default="test_output.mp4")
    parser.add_argument("--poll-interval", type=float, default=1.5, help="轮询间隔（秒），1-2 推荐")
    parser.add_argument("--max-polls", type=int, default=600)
    parser.add_argument("--timeout", type=int, default=60, help="HTTP 请求超时（秒）")
    parser.add_argument("--download-timeout", type=int, default=120, help="下载超时（秒）")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("缺少 --api-key 或环境变量 AGNES_API_KEY")
    if args.images:
        args.images = [u.strip() for u in args.images.split(",") if u.strip()]
    if args.audios:
        args.audios = [u.strip() for u in args.audios.split(",") if u.strip()]

    t0 = time.time()
    video_id = create_task(args)
    result_url = poll_task(args, video_id)
    download(result_url, args.output, timeout=args.download_timeout)
    print(f"[done] 总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()