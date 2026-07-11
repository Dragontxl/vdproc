FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    jq \
    parallel \
    awscli \
    bc \
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

RUN pip3 install --no-cache-dir \
    scenedetect \
    opencv-python-headless \
    numpy \
    torch \
    torchvision \
    insightface \
    Pillow \
    httpx \
    pydantic \
    requests \
    google-generativeai \
    scikit-learn

RUN mkdir -p /root/.insightface/models
RUN curl -sL https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip -o /tmp/buffalo_l.zip \
    && unzip /tmp/buffalo_l.zip -d /root/.insightface/models/ \
    && rm /tmp/buffalo_l.zip

WORKDIR /scripts

COPY scripts/ /scripts/

RUN chmod +x /scripts/*.sh && chmod +x /scripts/*.py

CMD ["bash", "-c", "echo 'AI Video Processor Ready' && sleep infinity"]