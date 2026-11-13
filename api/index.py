import json
import os
from pathlib import Path

import httpx  # type: ignore
from fastapi import Depends, FastAPI, HTTPException, Query  # type: ignore
from fastapi.responses import StreamingResponse  # type: ignore
from fastapi_clerk_auth import ClerkConfig, ClerkHTTPBearer, HTTPAuthorizationCredentials  # type: ignore
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

# Every request to /api must carry a valid Clerk session JWT
# (Authorization: Bearer <token>); otherwise FastAPI returns 403.
# This is set up after the .env files are loaded so CLERK_JWKS_URL is available.
clerk_config = ClerkConfig(jwks_url=os.getenv("CLERK_JWKS_URL"))
clerk_guard = ClerkHTTPBearer(clerk_config)

MODEL = "gpt-5-nano"
IDEAS_TABLE = "ideas"

# Must match the plan key in Clerk Billing and the plan checked in pages/product.tsx.
REQUIRED_PLAN = "premium_subscription"


def has_plan(claims: dict, plan: str) -> bool:
    """Return True if the Clerk session token says the user has `plan`.

    Clerk puts active Billing plans in the `pla` claim as a comma-separated list
    of scope:plan entries, e.g. "u:premium_subscription" (u = user plan,
    o = organization plan). This mirrors how Clerk's own frontend reads it.
    """
    for entry in str(claims.get("pla") or "").split(","):
        _, sep, value = entry.strip().partition(":")
        if sep and value == plan:
            return True
    return False


def supabase_settings() -> "tuple[str, str] | None":
    """Return (rest_url_for_ideas, secret_key), or None if Supabase isn't configured."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY")
    if not url or not key:
        return None
    return f"{url.rstrip('/')}/rest/v1/{IDEAS_TABLE}", key


def supabase_headers(key: str) -> dict:
    headers = {"apikey": key, "Content-Type": "application/json"}
    # Legacy service_role keys are JWTs and also go in the Authorization header.
    # New sb_secret_ keys are sent in the apikey header only.
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def save_idea(text: str, user_id: str) -> None:
    """Insert a finished idea, and the Clerk user who generated it, into the
    Supabase `ideas` table.

    Uses Supabase's REST API with the secret key, so it only ever runs on the
    server. Errors are printed, never raised, so a storage problem can't break
    the idea stream.
    """
    if not text.strip():
        return
    settings = supabase_settings()
    if not settings:
        print("SUPABASE_URL / SUPABASE_SECRET_KEY not set; skipping save")
        return
    endpoint, key = settings

    try:
        response = httpx.post(
            endpoint,
            headers={**supabase_headers(key), "Prefer": "return=minimal"},
            json={"content": text, "model": MODEL, "user_id": user_id},
            timeout=10,
        )
        if response.status_code >= 300:
            print(f"Failed to save idea to Supabase ({response.status_code}): {response.text}")
    except httpx.HTTPError as exc:
        print(f"Failed to save idea to Supabase: {exc}")


@app.get("/api")
def idea(creds: HTTPAuthorizationCredentials = Depends(clerk_guard)):
    user_id = creds.decoded["sub"]  # User ID from JWT - available for future use
    # We now know which user is making the request! 
    # You could use user_id to:
    # - Track usage per user
    # - Store generated ideas in a database
    # - Apply user-specific limits or customization

    # The page hides the generator from non-subscribers, but someone could still
    # call /api directly, so check the plan here too.
    if not has_plan(creds.decoded, REQUIRED_PLAN):
        raise HTTPException(status_code=403, detail="A premium subscription is required")

    client = OpenAI()
    prompt = [{"role": "user", "content": "Reply with a new business idea for AI Agents, formatted with headings, sub-headings and bullet points"}]
    stream = client.chat.completions.create(model=MODEL, messages=prompt, stream=True)

    def event_stream():
        full_text = []
        for chunk in stream:
            text = chunk.choices[0].delta.content
            if text:
                full_text.append(text)
                # Send each chunk JSON-encoded on a single data line. Raw newlines
                # would be split into several SSE data lines, and
                # @microsoft/fetch-event-source drops the empty ones, which loses
                # the blank lines and line breaks Markdown needs.
                yield f"data: {json.dumps(text)}\n\n"
        # The whole idea has been sent; store it before closing the stream.
        save_idea("".join(full_text), user_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


IDEAS_PAGE_SIZE = 10


@app.get("/api/ideas")
def list_ideas(
    page: int = Query(1, ge=1),
    creds: HTTPAuthorizationCredentials = Depends(clerk_guard),
):
    """Return one page (10 per page) of the signed-in user's saved ideas, newest first,
    plus the total count so the page can show "Page x of y".

    Only rows whose user_id matches the Clerk user in the verified token are
    returned, so users can never see each other's ideas (and old rows with no
    user_id are never shown).
    """
    user_id = creds.decoded["sub"]
    settings = supabase_settings()
    if not settings:
        raise HTTPException(status_code=500, detail="Idea storage is not configured")
    endpoint, key = settings

    try:
        response = httpx.get(
            endpoint,
            # count=exact makes Supabase report the total in the Content-Range header.
            headers={**supabase_headers(key), "Prefer": "count=exact"},
            params={
                "select": "id,content,created_at",
                "user_id": f"eq.{user_id}",
                "order": "created_at.desc",
                "limit": str(IDEAS_PAGE_SIZE),
                "offset": str((page - 1) * IDEAS_PAGE_SIZE),
            },
            timeout=10,
        )
    except httpx.HTTPError as exc:
        print(f"Failed to load ideas from Supabase: {exc}")
        raise HTTPException(status_code=502, detail="Could not load your ideas")
    # 416 means the page is past the end (e.g. after rows were deleted): return it empty.
    if response.status_code >= 300 and response.status_code != 416:
        print(f"Failed to load ideas from Supabase ({response.status_code}): {response.text}")
        raise HTTPException(status_code=502, detail="Could not load your ideas")

    # Content-Range looks like "0-9/42" (or "*/0" when empty); the part after "/" is the total.
    ideas = response.json() if response.status_code != 416 else []
    total_part = response.headers.get("content-range", "").rpartition("/")[2]
    total = int(total_part) if total_part.isdigit() else len(ideas)
    return {"ideas": ideas, "total": total, "page": page, "page_size": IDEAS_PAGE_SIZE}
