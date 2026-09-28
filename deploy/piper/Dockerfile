# Server-side voice for Flow Voice: Piper (neural TTS, CPU only) behind its small HTTP server.
#   POST /  {"text": "...", "voice": "no_NO-talesyntese-medium"}  →  audio/wav
# Voices are baked into the image so a vessel without internet still speaks. Idle = 0 CPU.
FROM python:3.11-slim
ARG VOICES="en_GB-alba-medium no_NO-talesyntese-medium sv_SE-nst-medium de_DE-thorsten-medium fr_FR-siwis-medium"
RUN pip install --no-cache-dir "piper-tts[http]==1.3.0" \
 && mkdir -p /voices \
 && python3 -m piper.download_voices --data-dir /voices ${VOICES}
USER nobody
EXPOSE 5000
CMD ["python3", "-m", "piper.http_server", "--host", "0.0.0.0", "--port", "5000", "--data-dir", "/voices", "-m", "en_GB-alba-medium"]
