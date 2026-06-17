"""
app.py
======
Hugging Face Spaces entry point for PharmAssist V2.

HF Spaces looks for app.py at the root and expects it to launch
the server. This file simply starts uvicorn pointing at main:app.

Do NOT rename this file — HF Spaces requires it to be called app.py.
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=7860,          # HF Spaces default port
        reload=False,       # never reload in production
    )
