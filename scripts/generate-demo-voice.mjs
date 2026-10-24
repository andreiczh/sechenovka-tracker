// Optional maintainer tool on macOS. Committed WAVs work on every deployment;
// the server never runs TTS or needs this tool at runtime.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DEMO_VOICE_SCENARIOS} from '../lib/demo-voices.mjs';
const root=new URL('../',import.meta.url);
await mkdir(new URL('test-results/demo-voice/',root),{recursive:true});
const result={};
function pcm(wav){
  if(wav.toString('ascii',0,4)!=='RIFF')throw new Error('Expected WAV');
  for(let i=12;i+8<=wav.length;){const size=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')return wav.subarray(i+8,i+8+size);i+=8+size+(size%2);}
  throw new Error('Missing audio');
}
function wave(data){
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);return Buffer.concat([header,data]);
}
for(const [id,scenario] of Object.entries(DEMO_VOICE_SCENARIOS)){
  for(const kind of ['patient','session']){
    const chunks=[],segments=[];let bytes=0;
    for(const [index,[role,text]] of scenario[kind].entries()){
      const file=new URL(`test-results/demo-voice/${id}-${kind}-${index}.wav`,root);
      const say=spawnSync('/usr/bin/say',['-v','Milena','-r',role==='doctor'?'180':'165','--file-format=WAVE','--data-format=LEI16@16000','-o',fileURLToPath(file),text],{encoding:'utf8'});
      if(say.status!==0)throw new Error('Could not create synthetic speech');
      const data=pcm(await readFile(file));segments.push({start:bytes/32000,end:(bytes+data.length)/32000});
      const gap=Buffer.alloc(6400);chunks.push(data,gap);bytes+=data.length+gap.length;
    }
    const file=`${id}-${kind}`,data=Buffer.concat(chunks);
    await writeFile(new URL(`public/assets/demo-voice/${file}.wav`,root),wave(data));
    result[file]={duration:bytes/32000,segments,method:'macos-milena-scripted-speech'};
  }
}
await writeFile(new URL('public/assets/demo-voice/manifest.json',root),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ok:true,files:Object.keys(result).length,seconds:Object.values(result).reduce((sum,a)=>sum+a.duration,0)}));
