import { open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const types={'poster.webp':'image/webp','arrival.webm':'video/webm','meadow.webm':'video/webm','meadow.gif':'image/gif','lake-nocturne.mp3':'audio/mpeg'};
export const inject=['connection'];

function requestedRange(raw,size){
  if(raw===null)return {start:0,end:size-1,status:200};
  const match=/^bytes=(\d*)-(\d*)$/u.exec(raw);
  if(!match||(!match[1]&&!match[2]))return null;
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end?{start,end,status:206}:null;
}

export function apply(ctx){
  for(const [name,type] of Object.entries(types)){
    const path=fileURLToPath(new URL('./media/'+name,import.meta.url));
    ctx.effect(()=>ctx.connection.fetch.register({path:'/api/yunshu/avalon-r39/'+name,methods:['GET','HEAD'],requestBody:'buffered',
      async fetch(req){
        const size=(await stat(path)).size,range=requestedRange(req.headers.get('Range'),size);
        const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=0, must-revalidate'};
        if(!range)return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+size}});
        const length=range.end-range.start+1;
        headers['Content-Length']=String(length);
        if(range.status===206)headers['Content-Range']='bytes '+range.start+'-'+range.end+'/'+size;
        if(req.method==='HEAD')return new Response(null,{status:range.status,headers});
        const file=await open(path,'r');
        try{
          const bytes=new Uint8Array(length);
          let got=0;
          while(got<length){
            req.signal.throwIfAborted();
            const part=await file.read(bytes,got,Math.min(128*1024,length-got),range.start+got);
            if(!part.bytesRead)throw Error('云舒场景文件提前结束。');
            got+=part.bytesRead;
          }
          return new Response(bytes,{status:range.status,headers});
        }finally{await file.close();}
      }}),'云舒湖畔素材 '+name);
  }
}
