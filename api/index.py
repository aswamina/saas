import os
from pathlib import Path

import httpx  # type: ignore
from fastapi import FastAPI  # type: ignore
from fastapi.responses import StreamingResponse  # type: ignore
from openai import OpenAI  # type: ignore

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Locally, read .env.local / .env from the project root (Next.js does this for the
# frontend, but uvicorn doesn't). On Vercel the variables come from the project's
# environment settings instead. Variables already set in the shell win.
if not os.environ.get("VERCEL"):
    try:
        from dotenv import load_dotenv  # type: ignore  # see requirements-dev.txt

        for name in (".env.local", ".env"):
            load_dotenv(PROJECT_ROOT / name, override=False)
    except ImportError:
        pass

app = FastAPI()

MODEL = "gpt-5-nano"
IDEAS_TABLE = "ideas"


def save_idea(text: str) -> None:
    """Insert a finished idea into the Supabase `ideas` table.

    Uses Supabase's REST API with the secret key, so it only ever runs on the
    server. Errors are printed, never raised, so a storage problem can't break
    the idea stream.
    """
    if not text.strip():
        return
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SECRET_KEY not set; skipping save")
        return

    headers = {
        "apikey": key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    # Legacy service_role keys are JWTs and also go in the Authorization header.
    # New sb_secret_ keys are sent in the apikey header only.
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"

    try:
        response = httpx.post(
            f"{url.rstrip('/')}/rest/v1/{IDEAS_TABLE}",
            headers=headers,
            json={"content": text, "model": MODEL},
            timeout=10,
        )
        if response.status_code >= 300:
            print(f"Failed to save idea to Supabase ({response.status_code}): {response.text}")
    except httpx.HTTPError as exc:
        print(f"Failed to save idea to Supabase: {exc}")


@app.get("/api")
def idea():
    client = OpenAI()
    prompt = [{"role": "user", "content": "Reply with a new business idea for AI Agents, formatted with headings, sub-headings and bullet points"}]
    stream = client.chat.completions.create(model=MODEL, messages=prompt, stream=True)

    def event_stream():
        full_text = []
        for chunk in stream:
            text = chunk.choices[0].delta.content
            if text:
                full_text.append(text)
                lines = text.split("\n")
                for line in lines:
                    yield f"data: {line}\n"
                yield "\n"
        # The whole idea has been sent; store it before closing the stream.
        save_idea("".join(full_text))

    return StreamingResponse(event_stream(), media_type="text/event-stream")
