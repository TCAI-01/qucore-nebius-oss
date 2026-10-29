# QuCoRe OSS: one container serving the API and the built web UI on port 8000.
#   docker compose up --build        (see README.md; Render: render.yaml)

# ---- 1. Build the React UI ----
FROM node:22-slim AS ui
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci
COPY frontend/ ./
# Monaco + Mermaid make a large bundle: give the build enough memory.
RUN NODE_OPTIONS=--max-old-space-size=6144 npm run build

# ---- 2. Python backend ----
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY Sonar/ /app/Sonar/
COPY --from=ui /app/frontend/dist /app/frontend/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/backend/data
EXPOSE 8000
# One uvicorn worker only: open workspaces, live jobs and streams are kept in this process's memory.
# Listens on $PORT when the platform sets it (Render), else 8000.
CMD ["/usr/local/bin/docker-entrypoint.sh"]
