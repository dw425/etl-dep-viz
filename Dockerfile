# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ .
RUN npm run build

# Stage 2: Python backend + serve built frontend
FROM python:3.11-slim
WORKDIR /app

# Install system deps for lxml
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2-dev libxslt1-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/pyproject.toml ./backend/
RUN pip install --no-cache-dir -e ./backend

# Copy backend code
COPY backend/ ./backend/

# Copy built frontend into backend/static
COPY --from=frontend-build /app/backend/static ./backend/static

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
WORKDIR /app/backend
