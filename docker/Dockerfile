FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    jq \
    parallel \
    awscli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /scripts

COPY scripts/ /scripts/

RUN chmod +x /scripts/*.sh

CMD ["bash", "-c", "echo 'AI Video Processor Ready' && sleep infinity"]