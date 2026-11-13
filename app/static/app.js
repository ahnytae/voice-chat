import {SpeechSegmenter, encodeWav} from './voice-capture.js';
const $ = id => document.getElementById(id);
const fields = ['base_url','model','voice','speed','steps','language','whisper','silence','threshold','speak','input_device','barge_in'];
try { const saved = JSON.parse(localStorage.getItem('secretary-settings') || '{}'); for (const id of fields) if (id in saved) { if (['speak','barge_in'].includes(id)) $(id).checked = saved[id]; else $(id).value = saved[id]; } } catch {}
function settings() { return {base_url:$('base_url').value,model:$('model').value,voice:$('voice').value,speed:Number($('speed').value),steps:Number($('steps').value),language:$('language').value}; }
for (const id of fields) $(id).addEventListener('change', () => { try { localStorage.setItem('secretary-settings', JSON.stringify(Object.fromEntries(fields.map(id=>[id,['speak','barge_in'].includes(id)?$(id).checked:$(id).value])))); } catch {} });
let history=[], busy=false, generation=0, controller=null, stream=null, capture=null, segmenter=null, phase='idle', activeReply=null, context=null, source=null, playback=null;
function status(text) { $('status').textContent=text; }
function error(e) { if (e?.name==='AbortError') return; $('error').textContent=e.message||String(e); $('error').hidden=false; }
async function checked(r) { if (!r.ok) { const j=await r.json().catch(()=>({detail:r.statusText})); throw new Error(typeof j.detail==='string'?j.detail:JSON.stringify(j.detail)); } return r; }
async function connect() { $('connection').textContent='연결 확인 중'; try { const r=await checked(await fetch('/api/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings())})); const data=await r.json(); $('models').replaceChildren(...data.models.map(x=>Object.assign(document.createElement('option'),{value:x}))); $('connection').textContent=`연결됨 · ${data.models.length}개 모델`; } catch(e) { $('connection').textContent='연결 필요'; error(e); } }
$('connect').onclick=connect; connect();
function message(role,text) { $('empty')?.remove(); const article=document.createElement('article'); article.className=`message ${role}`; const label=document.createElement('div');label.className='role';label.textContent=role==='user'?'나':'곁'; const body=document.createElement('div');body.className='body';body.textContent=text;article.append(label,body);$('conversation').append(article);article.scrollIntoView({block:'nearest'});return body; }
function setBusy(value) { busy=value; $('finish').disabled=phase==='transcribing'||!capture;  $('send').disabled=value;$('stop').disabled=!value; for(const id of fields) $(id).disabled=value; }
async function audioContext() { context ||= new AudioContext(); await context.resume(); return context; }
function idle() { phase='idle'; status(stream?'듣고 있어요':'대기 중'); }
function interrupt(preserveCapture=false) {
 generation++;controller?.abort();playback?.stop();playback=null;
 if(activeReply){if(activeReply.text.trim())history.push({role:'assistant',content:activeReply.text+' (사용자 발화로 중단됨)'});activeReply=null;}
 if(!preserveCapture)segmenter?.reset();phase='idle';setBusy(false);idle();
}
$('stop').onclick=()=>interrupt();
$('clear').onclick=()=>{interrupt();history=[];$('conversation').replaceChildren();$('error').hidden=true;};
async function say(text, signal, config, turn) { if (!text.trim()||turn!==generation) return; const r=await checked(await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,settings:config}),signal})); const data=await r.arrayBuffer();if(turn!==generation)return; const ctx=await audioContext();const decoded=await ctx.decodeAudioData(data);if(turn!==generation)return;status('말하고 있어요'); await new Promise((resolve,reject)=>{const node=ctx.createBufferSource();node.buffer=decoded;node.connect(ctx.destination);playback=node;node.onended=()=>{if(playback===node)playback=null;resolve();};node.start();}); }
async function send(text) {
 if(busy||!text.trim())return; const turn=++generation; controller=new AbortController(); const signal=controller.signal; const config=settings(); const speak=$('speak').checked;phase='responding';segmenter?.reset();setBusy(true);$('error').hidden=true;message('user',text);history.push({role:'user',content:text});history=history.slice(-30);const body=message('assistant','');activeReply={turn,text:''};let answer='',pending='',chain=Promise.resolve(),ttsFailed=false,done=false;
 const queue=t=>{chain=chain.then(()=>{if(ttsFailed||turn!==generation)return;return say(t,signal,config,turn);}).catch(e=>{if(turn===generation){ttsFailed=true;error(e);}});};
 try { status('생각하고 있어요');const r=await checked(await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:history,settings:config}),signal}));const reader=r.body.getReader();const decoder=new TextDecoder();let buffer='';
 while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='error')throw new Error(event.message);if(event.type==='done')done=true;if(event.type==='token'){if(turn!==generation)return;answer+=event.text;if(activeReply?.turn===turn)activeReply.text=answer;pending+=event.text;body.textContent=answer;if(speak){let match;while((match=pending.match(/^([\s\S]*?[.!?。！？](?:\s|$))/))){queue(match[1]);pending=pending.slice(match[1].length);}if(pending.length>180){let cut=pending.lastIndexOf(' ',180);if(cut<30)cut=180;queue(pending.slice(0,cut));pending=pending.slice(cut);}}}}}
 if(!done)throw new Error('LLM 연결이 응답 도중 끊겼습니다.');if(!answer.trim())throw new Error('빈 응답을 받았습니다. 모델 설정을 확인하세요.');if(speak)queue(pending);await chain;
 }catch(e){if(turn===generation)error(e);}finally{if(turn===generation){activeReply=null;if(answer.trim())history.push({role:'assistant',content:answer});else body.textContent='응답을 받지 못했습니다.';phase='idle';setBusy(false);idle();}else{const note=document.createElement('div');note.className='note';note.textContent='중단됨';body.parentElement.append(note);}}
}
$('composer').onsubmit=async e=>{e.preventDefault();const text=$('text').value.trim();if(!text||busy)return;if($('speak').checked)audioContext().catch(error);$('text').value='';send(text);};
document.querySelector('.suggestion').onclick=async()=>{if($('speak').checked)audioContext().catch(error);send('오늘 할 일을 함께 정리해줘.');};
let micStarting=false, workletReady=false;
function stopMic(){
 capture?.disconnect();if(capture)capture.port.onmessage=null;capture=null;segmenter?.reset();segmenter=null;
 stream?.getTracks().forEach(t=>t.stop());stream=null;source?.disconnect();source=null;
 $('finish').disabled=true;$('mic').textContent='마이크 켜기';$('mic').setAttribute('aria-pressed','false');$('level').value=0;
 $('mic_hint').textContent='마이크가 꺼져 있습니다.';if(!busy)status('대기 중');
}
async function listMicrophones(){
 const devices=await navigator.mediaDevices.enumerateDevices();const select=$('input_device'), previous=select.value;
 select.replaceChildren(Object.assign(document.createElement('option'),{value:'',textContent:'시스템 기본 마이크'}),...devices.filter(d=>d.kind==='audioinput'&&d.deviceId).map((d,i)=>Object.assign(document.createElement('option'),{value:d.deviceId,textContent:d.label||`마이크 ${i+1}`})));
 if([...select.options].some(o=>o.value===previous))select.value=previous;
}
async function startMic(){
 if(micStarting)return;micStarting=true;$('mic').disabled=true;$('error').hidden=true;status('마이크 권한을 확인하고 있어요');
 try{
  if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode)throw new Error('localhost 주소에서 최신 Chrome으로 접속하세요.');
  const ready=audioContext();
  const device=$('input_device').value;
  stream=await navigator.mediaDevices.getUserMedia({audio:{...(device?{deviceId:{exact:device}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
  await ready;source=context.createMediaStreamSource(stream);await listMicrophones();
  if(!workletReady){await context.audioWorklet.addModule('/pcm-worklet.js');workletReady=true;}
  const track=stream.getAudioTracks()[0];track.onended=()=>{stopMic();error(new Error('마이크 연결이 끊겼습니다. 장치를 확인한 뒤 다시 켜주세요.'));};
  $('mic').textContent='마이크 끄기';$('mic').setAttribute('aria-pressed','true');$('mic_hint').textContent=`연결됨: ${track.label||'기본 마이크'} · 말하면서 음량 막대가 움직이는지 확인하세요.`;startCapture();if(!busy)idle();
 }catch(e){stopMic();error(new Error('마이크를 켤 수 없습니다. 브라우저·macOS 마이크 권한과 입력 장치를 확인하세요. '+e.message));}
 finally{micStarting=false;$('mic').disabled=false;}
}
$('mic').onclick=()=>stream?stopMic():startMic();
$('finish').onclick=()=>{if(phase==='transcribing')return;if(busy)interrupt(true);segmenter?.flush();};
$('input_device').addEventListener('change',()=>{if(stream){stopMic();startMic();}});
function startCapture(){
 segmenter=new SpeechSegmenter(context.sampleRate, interrupting=>{
  if(interrupting){interrupt(true);$('mic_hint').textContent='답변을 중단했습니다. 계속 말씀하세요.';}
  status('듣고 있어요 · 말씀을 마치면 전송합니다');
 },pcm=>transcribeAudio(pcm));
 capture=new AudioWorkletNode(context,'pcm-capture');source.connect(capture);capture.connect(context.destination);
 const current=capture;
 capture.port.onmessage=event=>{
  if(capture!==current)return;
  const pcm=event.data;const rms=Math.sqrt(pcm.reduce((sum,v)=>sum+v*v,0)/pcm.length);$('level').value=rms;
  const responding=phase==='responding';
  segmenter.push(pcm,{enabled:phase!=='transcribing'&&(!responding||$('barge_in').checked),threshold:Number($('threshold').value)*(responding?1.5:1),silenceSeconds:Number($('silence').value),interrupting:responding});
 };
 $('finish').disabled=phase==='transcribing';
}
async function transcribeAudio(pcm){
 if(!stream||phase==='transcribing')return;
 const turn=++generation;controller=new AbortController();phase='transcribing';setBusy(true);status('말을 글로 바꾸고 있어요');
 try{
  const form=new FormData();form.append('audio',encodeWav(pcm,context.sampleRate),'speech.wav');form.append('model',$('whisper').value);form.append('language',$('language').value);
  const r=await checked(await fetch('/api/transcribe',{method:'POST',body:form,signal:controller.signal}));const data=await r.json();
  if(turn!==generation)return;phase='idle';setBusy(false);
  if(data.text)await send(data.text);else{$('mic_hint').textContent='인식된 말이 없습니다. 다시 말씀해주세요.';idle();}
 }catch(e){if(turn===generation){error(e);phase='idle';setBusy(false);idle();}}
}
window.addEventListener('pagehide',()=>{controller?.abort();stopMic();playback?.stop();context?.close();});
