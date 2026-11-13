// Run with a disposable Chrome listening on port 9359 and the app on 8765.
import assert from 'node:assert/strict';
const pages=await(await fetch('http://127.0.0.1:9359/json')).json();
const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
await new Promise(resolve=>ws.onopen=resolve);
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
function cmd(method,params={}){return new Promise((resolve,reject)=>{const i=++id;pending.set(i,{resolve,reject});ws.send(JSON.stringify({id:i,method,params}));});}
try {
 await cmd('Page.reload');await new Promise(r=>setTimeout(r,800));
 const result=await cmd('Runtime.evaluate',{awaitPromise:true,returnByValue:true,userGesture:true,expression:`(async()=>{
 const {encodeWav}=await import('/voice-capture.js');
 const evidence={chats:[],aborts:0,stops:0,uploads:[]};window.evidence=evidence;
 const originalStop=AudioBufferSourceNode.prototype.stop;
 AudioBufferSourceNode.prototype.stop=function(...args){evidence.stops++;return originalStop.apply(this,args)};
 const fixture=new AudioContext();await fixture.resume();const dest=fixture.createMediaStreamDestination();
 const gain=fixture.createGain();gain.gain.value=0;const tone=fixture.createOscillator();tone.frequency.value=300;tone.connect(gain);gain.connect(dest);tone.start();
 navigator.mediaDevices.getUserMedia=async()=>dest.stream;
 const originalFetch=window.fetch.bind(window);
 window.fetch=async(url,options)=>{
  if(url==='/api/transcribe'){const file=options.body.get('audio');const data=await file.arrayBuffer();evidence.uploads.push({size:data.byteLength,rate:new DataView(data).getUint32(24,true)});return Response.json({text:'새로운 질문입니다'});}
  if(url==='/api/speech')return new Response(encodeWav(new Float32Array(48000*10),48000));
  if(url==='/api/chat'){
   evidence.chats.push(JSON.parse(options.body));const second=evidence.chats.length>1;
   return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify({type:'token',text:second?'새 질문에 대한 답변입니다.':'이전 답변을 읽고 있습니다.'})+'\\n'));if(second){c.enqueue(new TextEncoder().encode(JSON.stringify({type:'done'})+'\\n'));c.close();}else options.signal.addEventListener('abort',()=>{evidence.aborts++;c.error(new DOMException('Aborted','AbortError'));});}}));
  }
  return originalFetch(url,options);
 };
 const waitFor=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+document.getElementById('status').textContent);};
 document.getElementById('mic').click();await waitFor(()=>document.getElementById('mic').getAttribute('aria-pressed')==='true');
 document.getElementById('text').value='첫 질문입니다';document.getElementById('composer').requestSubmit();
 await waitFor(()=>document.getElementById('status').textContent==='말하고 있어요');
 gain.gain.value=.2;await waitFor(()=>evidence.aborts===1);document.getElementById('speak').checked=false;
 await new Promise(r=>setTimeout(r,400));gain.gain.value=0;
 await waitFor(()=>evidence.chats.length===2);await waitFor(()=>document.getElementById('status').textContent==='듣고 있어요');
 document.getElementById('mic').click();tone.stop();await fixture.close();
 evidence.messages=[...document.querySelectorAll('.message .body')].map(e=>e.textContent);
 evidence.notes=[...document.querySelectorAll('.note')].map(e=>e.textContent);
 evidence.error=document.getElementById('error').textContent;
 return JSON.stringify(evidence);
})()`});
 if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
 const evidence=JSON.parse(result.result.value);
 assert.equal(evidence.aborts,1);assert.equal(evidence.stops,1);assert.equal(evidence.uploads.length,1);assert.ok(evidence.uploads[0].size>44);
 assert.equal(evidence.chats.length,2);assert.equal(evidence.chats[1].messages.at(-1).content,'새로운 질문입니다');
 assert.ok(evidence.chats[1].messages.some(m=>m.role==='assistant'&&m.content.includes('중단됨')));
 assert.equal(evidence.messages.at(-1),'새 질문에 대한 답변입니다.');assert.equal(evidence.error,'');assert.deepEqual(evidence.notes,['중단됨']);
 console.log(JSON.stringify(evidence,null,2));
} finally {ws.close();}
