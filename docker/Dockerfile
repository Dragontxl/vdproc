FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    jq \
    parallel \
    awscli \
    python3 \
    python3-pip \
    python3-dev \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

RUN mkdir -p /root/.insightface/models
RUN curl -sL https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip -o /tmp/buffalo_l.zip \
    && unzip /tmp/buffalo_l.zip -d /root/.insightface/models/ \
    && rm /tmp/buffalo_l.zip

# EAST 文本检测模型（用于去字幕；下载失败则去字幕回退固定底部条带）
RUN mkdir -p /opt/east \
    && (curl -sL --retry 3 --max-time 600 https://github.com/oyyd/frozen_east_text_detection.pb/raw/master/frozen_east_text_detection.pb -o /opt/east/frozen_east_text_detection.pb \
        && [ -s /opt/east/frozen_east_text_detection.pb ] \
        || (echo "WARN: EAST model download failed; subtitle removal will fall back to fixed band" && rm -f /opt/east/frozen_east_text_detection.pb))

WORKDIR /scripts

COPY scripts/ /scripts/

RUN chmod +x /scripts/*.sh && chmod +x /scripts/*.py

CMD ["bash", "-c", "echo 'AI Video Processor Ready' && sleep infinity"]