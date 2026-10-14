import io
import edge_tts
from aiohttp import web

VOICE = "en-GB-SoniaNeural"
PITCH = "-2Hz"       # Slightly deeper for the mature secretary timbre
RATE = "+0%"         # Conversational executive pacing

async def tts_handler(request):
    data = await request.json()
    text = data.get("text", "")
    if not text:
        return web.Response(status=400, text="No text provided")

    # Generate audio buffer in memory without writing to disk
    communicate = edge_tts.Communicate(text, VOICE, pitch=PITCH, rate=RATE)
    audio_buffer = io.BytesIO()
    
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_buffer.write(chunk["data"])

    audio_buffer.seek(0)
    return web.Response(
        body=audio_buffer.read(),
        content_type="audio/mpeg",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }
    )

async def options_handler(request):
    return web.Response(
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }
    )

app = web.Application()
app.router.add_post("/tts", tts_handler)
app.router.add_options("/tts", options_handler)

if __name__ == "__main__":
    print(f"[*] Sonia Voice Engine active at http://0.0.0.0:5050/tts")
    web.run_app(app, host="0.0.0.0", port=5050)