"""Loopback-only voice assistant. Models load lazily and stay resident."""
import asyncio
import io
import json
import os
import threading
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('HF_HOME', str(ROOT / 'models' / 'huggingface'))
import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

app = FastAPI(title='Local Secretary')
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', '[::1]'])

@app.middleware('http')
async def local_origin(request: Request, call_next):
    origin = request.headers.get('origin')
    if origin and urlparse(origin).netloc != request.headers.get('host'):
        return Response('Cross-origin requests are disabled', status_code=403)
    return await call_next(request)

stt_lock, tts_lock = threading.Lock(), threading.Lock()
stt_model = tts_model = None
stt_name = None

class Settings(BaseModel):
    base_url: str = 'http://127.0.0.1:11434/v1'
    model: str = Field(default='qwen2.5:14b', min_length=1, max_length=150)
    voice: str = Field(default='F1', pattern=r'^[FM][1-5]$')
    speed: float = Field(default=1.05, ge=0.7, le=2)
    steps: int = Field(default=5, ge=2, le=15)
    language: Literal['ko', 'en', 'fr', 'es', 'pt'] = 'ko'

    @field_validator('base_url')
    @classmethod
    def loopback_only(cls, value):
        parsed = urlparse(value)
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.query or parsed.fragment:
            raise ValueError('로컬 LLM 주소(localhost 또는 127.0.0.1)를 입력하세요.')
        return value.rstrip('/')

class Message(BaseModel):
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=12000)

class ChatInput(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=40)
    settings: Settings = Field(default_factory=Settings)

class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    settings: Settings = Field(default_factory=Settings)

SYSTEM = '당신은 한국어 개인 음성 비서입니다. 자연스럽고 간결하게 답하세요. 기본적으로 2~4문장으로 답하고, 음성으로 읽기 어렵게 만드는 마크다운이나 표는 피하세요. 실제 실행 도구가 없으므로 파일 수정, 일정 등록 등을 실행했다고 주장하지 마세요.'

def transcribe(data, model_name, language):
    global stt_model, stt_name
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    with stt_lock:
        audio = decode_audio(io.BytesIO(data), sampling_rate=16000)
        if len(audio) > 16000 * 35:
            raise ValueError('한 번에 35초 이하로 말해주세요.')
        if stt_model is None or stt_name != model_name:
            stt_model = None
            stt_model = WhisperModel(model_name, device='cpu', compute_type='int8', cpu_threads=4, download_root=str(ROOT / 'models' / 'whisper'))
            stt_name = model_name
        segments, _ = stt_model.transcribe(audio, language=language, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        return ''.join(s.text for s in segments if s.no_speech_prob < 0.8).strip()

def synthesize(text, settings):
    global tts_model
    import soundfile as sf
    from supertonic import TTS
    with tts_lock:
        if tts_model is None:
            tts_model = TTS(model='supertonic-2', model_dir=ROOT / 'models' / 'supertonic-2', auto_download=True, intra_op_num_threads=4)
        style = tts_model.get_voice_style(settings.voice)
        wav, _ = tts_model.synthesize(text, voice_style=style, lang=settings.language, total_steps=settings.steps, speed=settings.speed)
        output = io.BytesIO()
        sf.write(output, wav.reshape(-1), tts_model.sample_rate, format='WAV', subtype='PCM_16')
        return output.getvalue()

@app.get('/api/status')
async def status():
    return {'stt_loaded': stt_model is not None, 'stt_model': stt_name, 'tts_loaded': tts_model is not None, 'tts_model': 'Supertone/supertonic-2'}

@app.post('/api/models')
async def models(settings: Settings):
    try:
        async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
            r = await client.get(settings.base_url + '/models')
            r.raise_for_status()
            return {'models': [m['id'] for m in r.json()['data']]}
    except Exception as e:
        raise HTTPException(503, f'로컬 LLM에 연결할 수 없습니다. Ollama 실행과 주소를 확인하세요. {e}') from e

@app.post('/api/transcribe')
async def stt(audio: UploadFile = File(...), model: Literal['tiny', 'base', 'small', 'medium', 'large-v3-turbo'] = Form('small'), language: Literal['ko', 'en', 'fr', 'es', 'pt'] = Form('ko')):
    data = await audio.read(8 * 1024 * 1024 + 1)
    await audio.close()
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, '녹음이 너무 큽니다.')
    try:
        text = await asyncio.to_thread(transcribe, data, model, language)
        return {'text': text}
    except Exception as e:
        raise HTTPException(503, f'음성 인식 실패: {e}') from e

@app.post('/api/speech')
async def speech(payload: SpeechInput):
    try:
        data = await asyncio.to_thread(synthesize, payload.text, payload.settings)
        return Response(data, media_type='audio/wav', headers={'Cache-Control': 'no-store'})
    except Exception as e:
        raise HTTPException(503, f'Supertonic-2 실행 실패: {e}') from e

@app.post('/api/chat')
async def chat(payload: ChatInput):
    async def events():
        def event(obj):
            return json.dumps(obj, ensure_ascii=False) + '\n'
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10), trust_env=False) as client:
                async with client.stream('POST', payload.settings.base_url + '/chat/completions', json={
                    'model': payload.settings.model, 'stream': True, 'max_tokens': 512,
                    'messages': [{'role': 'system', 'content': SYSTEM}] + [m.model_dump() for m in payload.messages],
                }) as r:
                    if r.status_code != 200:
                        raise RuntimeError((await r.aread()).decode()[:500])
                    async for line in r.aiter_lines():
                        if not line.startswith('data: '):
                            continue
                        data = line[6:]
                        if data == '[DONE]':
                            break
                        obj = json.loads(data)
                        if obj.get('error'):
                            raise RuntimeError(str(obj['error']))
                        choices = obj.get('choices', [])
                        token = choices[0].get('delta', {}).get('content') if choices else None
                        if token:
                            yield event({'type': 'token', 'text': token})
            yield event({'type': 'done'})
        except Exception as e:
            yield event({'type': 'error', 'message': f'LLM 응답 실패: {e}'})
    return StreamingResponse(events(), media_type='application/x-ndjson', headers={'Cache-Control': 'no-store'})

app.mount('/', StaticFiles(directory=ROOT / 'app' / 'static', html=True), name='web')
