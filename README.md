# 곁 · Local Secretary

Whisper 음성 인식 → 로컬 LLM → **Supertone/supertonic-2** 음성 출력으로 대화하는 개인 비서입니다. FastAPI 서버와 빌드가 필요 없는 웹 화면으로 구성합니다.

## 실행

```sh
cd /Users/ahny/dev/local-secretary
./scripts/setup.sh
.venv/bin/python scripts/download_models.py
./scripts/start.sh
```

브라우저에서 **http://127.0.0.1:8765** 를 열고 마이크 권한을 허용하세요. Ollama가 실행 중이어야 합니다. 실행되지 않았다면 별도 터미널에서 `ollama serve`를 실행합니다. 기본 모델은 이미 설치되어 있는 `qwen2.5:14b`입니다. 다른 환경에서는 해당 모델을 먼저 `ollama pull qwen2.5:14b`로 설치하거나 화면에서 설치된 모델을 선택하세요.

이미 가상환경과 패키지가 설치된 경우 `./scripts/start.sh`만 실행하면 됩니다. 최초 모델 다운로드는 인터넷이 필요합니다. 모델을 받은 뒤에는 음성 인식/LLM/TTS가 로컬에서 실행됩니다. 음성과 대화 기록은 파일에 저장하지 않으며, 새로고침하면 대화가 사라집니다. 설정만 브라우저 localStorage에 저장합니다.

## 사용 흐름

1. ‘연결과 목소리 설정’에서 모델 연결을 확인합니다.
2. ‘마이크 켜기’를 누르고 말합니다. 기본 0.9초 침묵 후 발화를 전송합니다.
3. Whisper가 한국어 텍스트를 만들고 LLM에 전달합니다.
4. LLM 텍스트를 실시간 표시하고, 문장별로 Supertonic-2가 음성을 합성해 재생합니다.
5. 답변 중에도 마이크를 듣습니다. 말을 시작하면 기존 재생과 응답 요청을 취소하고 새 발화를 받습니다. ‘답변 중단’ 버튼도 사용할 수 있습니다.

텍스트 입력도 지원합니다. 소음이 있는 곳에서는 감도를 낮추고, 말 사이의 긴 쉼이 잘리는 경우 발화 종료 대기를 늘리세요. 마이크 입력은 브라우저의 음량 기반 감지로 나누고, Whisper 단계에서는 Silero VAD로 비음성 구간을 거릅니다.

## 구성과 설정

| 부분 | 기본값 |
| --- | --- |
| STT | faster-whisper `small`, CPU int8, 4 threads |
| LLM | Ollama OpenAI 호환 API, `http://127.0.0.1:11434/v1` |
| TTS | `supertonic` Python 패키지, 모델 **supertonic-2** 명시 |
| 음성 | F1, 한국어, 속도 1.05, 합성 5단계 |
| 웹 서버 | `127.0.0.1:8765` |
| 모델 캐시 | 프로젝트의 `models/` |

Mac에서 Whisper는 이 구현상 CPU를 사용합니다. Metal을 사용하는 whisper.cpp/MLX로 교체하는 최적화는 포함하지 않았습니다. 음성 입력은 발화 종료 후 인식하는 방식이며, 말하는 도중의 실시간 자막은 제공하지 않습니다. AudioWorklet으로 마이크 PCM을 계속 받고, 답변 중 약 0.28초 이상 이어지는 말소리를 감지하면 응답을 중단합니다. 감지 직전 약 0.4초의 음성을 함께 보관해 발화 시작 부분을 유지합니다. 인식 요청이 진행 중인 동안에는 새 음성을 수집하지 않습니다. 브라우저의 에코 제거를 사용하지만 스피커 환경에서 완벽한 구분은 보장하지 않습니다. 오감지가 있으면 이어폰을 사용하거나 설정의 ‘말하면 답변 중단하기’를 끄세요. 28초가 넘는 발화는 구간을 나눕니다. LLM은 최근 30개 메시지를 보내고 최대 512토큰 답변을 요청합니다.

CPU 추론은 실행 중 즉시 중단되지 않습니다. 중단 후 이미 시작된 Whisper/TTS 연산은 마칠 수 있지만 이전 결과는 재생하거나 새 대화에 반영하지 않습니다. 모델 추론은 엔진별 lock으로 직렬화합니다. 다중 사용자용 서버가 아닌 개인용 프로토타입입니다.

일정 등록, 파일 조작, 검색 같은 행동 도구는 없습니다. 현재 기능은 음성 대화와 대화 맥락 유지입니다. 응답 시간은 모델 크기, 메모리 여유, 발화 길이에 따라 달라집니다.

## 파일

- `app/main.py`: 로컬 API, Whisper/Supertonic 엔진, LLM 스트리밍
- `app/static/`: 한국어 단일 대화 화면, 녹음, 발화 감지, 음성 재생
- `scripts/download_models.py`: 음성 모델 다운로드 및 TTS 예열
- `requirements.txt`: 지원하는 의존성 범위
- `requirements.lock.txt`: 이 환경에 설치된 정확한 버전 (`pip install -r requirements.lock.txt`)

## 문제 해결

- LLM 연결 실패: Ollama 실행 여부, 주소, 모델명을 확인합니다. LM Studio 등도 loopback의 OpenAI 호환 `/v1` 주소로 연결할 수 있습니다.
- 최초 음성 응답이 느림: 모델 다운로드/예열 중일 수 있습니다. 다운로드 스크립트를 먼저 실행하세요.
- 마이크 접근 실패: localhost 주소로 접속하고 브라우저 및 macOS 마이크 권한을 허용하세요. 최신 Chrome을 권장합니다.
- 음성 합성 실패: 터미널 오류와 모델 다운로드 상태를 확인하세요. 화면에서 음성 출력을 끄면 텍스트 대화는 계속 사용할 수 있습니다.

## 공식 자료

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [Supertonic Python SDK](https://github.com/supertone-oss-archive/supertonic-py)
- [Supertonic-2 모델](https://huggingface.co/Supertone/supertonic-2)

## 자동 답변 중단 확인

`node tests/voice-capture.mjs`로 발화 시작, 짧은 잡음 억제, 녹음 길이 제한, WAV 인코딩을 확인합니다. `tests/browser-barge.mjs`는 localhost:8765 앱과 디버그 포트 9359의 별도 Chrome을 사용합니다. 가상 마이크와 API 대역으로 실제 AudioWorklet/재생/취소 흐름을 확인하며, 실제 음성 인식 정확도나 물리적 에코를 검증하는 테스트는 아닙니다.
