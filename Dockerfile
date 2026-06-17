# =============================================================================
# PharmAssist V2 — Dockerfile
# Hugging Face Spaces — Docker SDK
# =============================================================================

FROM python:3.11-slim

# --- System dependencies ------------------------------------------------------
# build-essential is required to compile rapidfuzz C extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# --- Create non-root user (security best practice) ----------------------------
RUN useradd -m -u 1000 pharmuser

# --- Working directory --------------------------------------------------------
WORKDIR /app

# --- Python dependencies (cached layer — only rebuilds if requirements change) -
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Copy application files ---------------------------------------------------
COPY main.py        .
COPY db_utils.py    .
COPY rag_agent.py   .
COPY app.py         .
COPY static/        ./static/

# --- Ownership ----------------------------------------------------------------
RUN chown -R pharmuser:pharmuser /app

USER pharmuser

# --- HF Spaces requires port 7860 --------------------------------------------
EXPOSE 7860

# --- Startup ------------------------------------------------------------------
CMD ["python", "app.py"]
