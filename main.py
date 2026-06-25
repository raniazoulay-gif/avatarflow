"""
AvatarFlow — AI Marketing Video Generator
FastAPI backend with HeyGen + Claude APIs
"""
import os
import json
import urllib.request
import urllib.error
import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from database import init_db, save_video, update_video_status, get_all_videos, get_video_by_heygen_id

app = FastAPI(title="AvatarFlow")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
_static_dir = os.path.join(BASE_DIR, "static")
if os.path.isdir(_static_dir):
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

HEYGEN_API_KEY = os.environ.get("HEYGEN_API_KEY", "")
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
HEYGEN_BASE = "https://api.heygen.com"


def heygen_headers():
    return {
        "X-Api-Key": HEYGEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }



# ── Pages ──────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    videos = get_all_videos()
    total = len(videos)
    pending = sum(1 for v in videos if v["status"] == "processing")
    completed = sum(1 for v in videos if v["status"] == "completed")
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={
            "videos": videos,
            "total": total,
            "pending": pending,
            "completed": completed,
        }
    )


@app.get("/create", response_class=HTMLResponse)
async def create_page(request: Request):
    return templates.TemplateResponse(request=request, name="create.html", context={})


# ── API ────────────────────────────────────────────────────────────────────────

@app.post("/api/generate-script")
async def generate_script(request: Request):
    body = await request.json()
    product = body.get("product", "")
    audience = body.get("audience", "")
    language = body.get("language", "Hebrew")
    tone = body.get("tone", "Professional")
    duration = body.get("duration", "30")

    tone_map = {
        "Professional": "מקצועי ואמין",
        "Friendly": "ידידותי וחמים",
        "Energetic": "אנרגטי ומרגש",
        "Luxury": "יוקרתי ומעודן"
    }
    tone_heb = tone_map.get(tone, tone)

    lang_map = {
        "Hebrew": "עברית",
        "English": "English",
        "Arabic": "العربية"
    }
    lang_display = lang_map.get(language, language)

    if language == "Hebrew":
        prompt = f"""כתוב סקריפט לוידאו שיווקי בעברית עבור:
מוצר/שירות: {product}
קהל יעד: {audience}
טון: {tone_heb}
אורך: {duration} שניות (בערך {int(duration)//3} משפטים קצרים)

הסקריפט צריך להיות:
- ישיר ומשכנע
- מדבר לקהל היעד
- לכלול call-to-action בסוף
- מוכן לדיבור (ללא כותרות, רק טקסט רציף)

החזר רק את הסקריפט עצמו, ללא הסברים."""
    elif language == "Arabic":
        prompt = f"""اكتب سكريبت لفيديو تسويقي باللغة العربية لـ:
المنتج/الخدمة: {product}
الجمهور المستهدف: {audience}
النبرة: {tone}
المدة: {duration} ثانية (حوالي {int(duration)//3} جمل قصيرة)

يجب أن يكون السكريبت:
- مباشراً ومقنعاً
- يخاطب الجمهور المستهدف
- يتضمن call-to-action في النهاية
- جاهزاً للتحدث (بدون عناوين، نص متواصل فقط)

أرجع السكريبت فقط بدون شرح."""
    else:
        prompt = f"""Write a marketing video script in English for:
Product/Service: {product}
Target Audience: {audience}
Tone: {tone}
Duration: {duration} seconds (approximately {int(duration)//3} short sentences)

The script should be:
- Direct and persuasive
- Speaking to the target audience
- Include a call-to-action at the end
- Ready to speak (no headings, just continuous text)

Return only the script itself, without explanations."""

    try:
        payload = json.dumps({
            "model": "claude-sonnet-4-6",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}]
        }).encode("utf-8")

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            script = result["content"][0]["text"].strip()
            return JSONResponse({"script": script})
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", errors="replace")
        return JSONResponse({"error": f"Claude API error: {e.code} — {body_err[:300]}"}, status_code=500)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# In-memory cache for avatars and voices
_avatars_cache = []
_voices_cache = []


def _fetch_avatars_from_heygen():
    global _avatars_cache
    try:
        r = requests.get(f"{HEYGEN_BASE}/v2/avatars", headers=heygen_headers(), timeout=60)
        data = r.json()
        avatars_raw = data.get("data", {}).get("avatars", [])
        seen = set()
        result = []
        for a in avatars_raw:
            aid = a.get("avatar_id", "")
            if aid and aid not in seen:
                seen.add(aid)
                result.append({
                    "avatar_id": aid,
                    "name": a.get("avatar_name", ""),
                    "preview_image_url": a.get("preview_image_url", ""),
                })
        _avatars_cache = result
        print(f"[AvatarFlow] Loaded {len(_avatars_cache)} avatars")
    except Exception as e:
        print(f"[AvatarFlow] Avatar preload error: {e}")


def _fetch_voices_from_heygen():
    global _voices_cache
    try:
        r = requests.get(f"{HEYGEN_BASE}/v2/voices", headers=heygen_headers(), timeout=60)
        data = r.json()
        voices_raw = data.get("data", {}).get("voices", [])
        result = []
        for v in voices_raw:
            if v.get("voice_id") and v.get("display_name"):
                result.append({
                    "voice_id": v.get("voice_id"),
                    "name": v.get("display_name", ""),
                    "language": v.get("language", ""),
                    "gender": v.get("gender", ""),
                })
        _voices_cache = result
        print(f"[AvatarFlow] Loaded {len(_voices_cache)} voices")
    except Exception as e:
        print(f"[AvatarFlow] Voice preload error: {e}")


@app.on_event("startup")
async def on_startup():
    import threading
    init_db()
    threading.Thread(target=_fetch_avatars_from_heygen, daemon=True).start()
    threading.Thread(target=_fetch_voices_from_heygen, daemon=True).start()


@app.get("/api/avatars")
async def get_avatars(search: str = ""):
    avatars = _avatars_cache
    if search:
        s = search.lower()
        avatars = [a for a in avatars if s in a["name"].lower()]
    return JSONResponse({"avatars": avatars[:200], "total": len(_avatars_cache)})


@app.get("/api/voices")
async def get_voices(language: str = ""):
    voices = _voices_cache
    if language:
        voices = [v for v in voices if language.lower() in v.get("language", "").lower()]
    return JSONResponse({"voices": voices})


@app.post("/api/create-video")
async def create_video(request: Request):
    body = await request.json()
    script = body.get("script", "")
    avatar_id = body.get("avatar_id", "")
    voice_id = body.get("voice_id", "")
    title = body.get("title", "Marketing Video")
    language = body.get("language", "")
    avatar_name = body.get("avatar_name", "")

    if not script or not avatar_id or not voice_id:
        return JSONResponse({"error": "script, avatar_id, and voice_id are required"}, status_code=400)

    payload = {
        "video_inputs": [{
            "character": {
                "type": "avatar",
                "avatar_id": avatar_id,
                "avatar_style": "normal"
            },
            "voice": {
                "type": "text",
                "input_text": script,
                "voice_id": voice_id
            },
            "background": {
                "type": "color",
                "value": "#FFFFFF"
            }
        }],
        "dimension": {"width": 1280, "height": 720},
        "aspect_ratio": "16:9"
    }

    try:
        resp = requests.post(
            f"{HEYGEN_BASE}/v2/video/generate",
            headers=heygen_headers(),
            json=payload,
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        heygen_video_id = data.get("data", {}).get("video_id", "")
        if not heygen_video_id:
            return JSONResponse({"error": f"No video_id in response: {data}"}, status_code=500)

        save_video(
            heygen_video_id=heygen_video_id,
            title=title,
            script=script,
            avatar_id=avatar_id,
            avatar_name=avatar_name,
            voice_id=voice_id,
            language=language,
        )
        return JSONResponse({"video_id": heygen_video_id, "status": "processing"})
    except requests.HTTPError as e:
        return JSONResponse({"error": f"HeyGen API error: {e.response.status_code} — {e.response.text[:300]}"}, status_code=500)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/video-status/{video_id}")
async def video_status(video_id: str):
    try:
        resp = requests.get(
            f"{HEYGEN_BASE}/v1/video_status.get?video_id={video_id}",
            headers=heygen_headers(),
            timeout=15
        )
        resp.raise_for_status()
        data = resp.json()
        video_data = data.get("data", {})
        status = video_data.get("status", "processing")
        video_url = video_data.get("video_url", "")
        thumbnail_url = video_data.get("thumbnail_url", "")

        if status in ("completed", "failed"):
            update_video_status(video_id, status, video_url, thumbnail_url)

        return JSONResponse({
            "video_id": video_id,
            "status": status,
            "video_url": video_url,
            "thumbnail_url": thumbnail_url,
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
