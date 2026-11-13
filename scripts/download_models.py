"""Download and warm up both speech models before using the microphone."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.main import ROOT, Settings, synthesize
from faster_whisper import WhisperModel
name = sys.argv[1] if len(sys.argv) > 1 else 'small'
print(f'Downloading Whisper {name}...', flush=True)
WhisperModel(name, device='cpu', compute_type='int8', download_root=str(ROOT / 'models' / 'whisper'))
print('Downloading Supertonic-2 and synthesizing a warm-up sentence...', flush=True)
synthesize('안녕하세요. 저는 당신의 로컬 비서입니다.', Settings())
print('Both speech models are ready.')
