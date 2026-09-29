FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PUSHKA_DB=/var/lib/pushka/pushka.sqlite3 PORT=8000
WORKDIR /app
COPY pushka/ /app/pushka/
COPY certs/ /app/certs/
COPY static/ /app/static/
COPY data/ /app/data/
RUN useradd -r -u 10001 pushka && mkdir -p /var/lib/pushka && chown pushka:pushka /var/lib/pushka
USER pushka
EXPOSE 8000
CMD ["python", "-m", "pushka.server"]
