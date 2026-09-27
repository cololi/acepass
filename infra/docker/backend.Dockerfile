# AcePass backend image: one image, several start commands (api / worker / beat).
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libpq is needed by psycopg even in binary mode at import time on slim images;
# build tooling is not kept in the final layer beyond whats in the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements/base.txt backend/requirements/lock.txt ./requirements/
RUN pip install --no-cache-dir -r requirements/lock.txt gunicorn

COPY backend/ ./
# The built SPA is served by the nginx service; the API only needs the files if
# you choose to serve index.html from Django instead.
COPY frontend/dist/ /app/frontend-dist/

RUN useradd --create-home --uid 10001 acepass \
 && mkdir -p /data/private-media /app/var/static \
 && chown -R acepass:acepass /data /app
USER acepass

ENV ACEPASS_FRONTEND_DIST=/app/frontend-dist \
    DJANGO_STATIC_ROOT=/app/var/static

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000"]
