# Backup speech recogniser for the Flow Voice hub: whisper.cpp's HTTP server, CPU only.
# Small on purpose: a C++ binary (no Python), a quantised model mounted from the host, nothing running while idle.
# GGML_CPU_ALL_VARIANTS builds every x86 / ARM kernel set and picks the best one at start, so the same image
# runs on an old VM, a modern server and a Raspberry Pi (build it on the target architecture).
FROM debian:bookworm-slim AS build
ARG WHISPER_REF=v1.8.2
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_INSTALL_PREFIX=/opt/whisper \
 && cmake --build build -j"$(nproc)" --target whisper-server \
 && mkdir -p /opt/whisper/bin /opt/whisper/lib \
 && cp build/bin/whisper-server /opt/whisper/bin/ \
 && find build -name '*.so*' -exec cp -a {} /opt/whisper/lib/ \;

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/whisper /opt/whisper
ENV LD_LIBRARY_PATH=/opt/whisper/lib
WORKDIR /opt/whisper/lib
USER 1000:1000
EXPOSE 8080
# -ac 384: answers are short, so encode 7.7 s of context instead of 30 (a quarter of the CPU per request; the hub caps uploads at 8 s)
# -nf: no temperature fallback (one decoding pass, bounded latency)
ENTRYPOINT ["/opt/whisper/bin/whisper-server", "--host", "0.0.0.0", "--port", "8080", "--inference-path", "/v1/audio/transcriptions", "-nf", "-ac", "384"]
CMD ["-m", "/models/ggml-small-q5_1.bin", "-t", "4"]
