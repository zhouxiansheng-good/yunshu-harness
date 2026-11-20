/** Data-only snapshot of an approved original ticket. No candidate file is loaded as code. */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {lstatSync,mkdirSync,readdirSync,realpathSync,renameSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readDiagnosisSource} from './diagnosis-input.mjs';
import {originalTextMaterial} from './initial-ticket.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
function directory(path) {
  const st=lstatSync(path);if(!st.isDirectory() || st.isSymbolicLink() || realpathSync(path)!==path) throw Error('initial-stage-directory-invalid');
}
function matches(path,expected) {
  directory(path);const names=Object.keys(expected).filter(n=>expected[n]!==null).sort();
  if(!same(readdirSync(path).sort(),names))throw Error('initial-stage-inventory-changed');
  for(const n of names){const p=join(path,n),s=lstatSync(p);
    if(s.nlink!==1 || !s.isFile() || s.isSymbolicLink() || readDiagnosisSource(p,32*1024).sha256!==expected[n])throw Error('initial-stage-content-changed');}
}
export function originalTextStage(co,host,ticketId,existingOnly) {
  const initial=originalTextMaterial(co,host,ticketId);if(!initial.recovered)return {ticketId,ready:false,reason:initial.reason};
  const {candidateSha256,requestSha256,files}=initial;
  const hashes=Object.fromEntries(files.map(({name,text})=>[name,text===null?null:sha(text)]));
  const parent=join(co.stateDir,'initial-text-stages'), directoryPath=join(parent,ticketId+'.'+candidateSha256);
  if(!existingOnly)try{mkdirSync(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  directory(parent);
  if(!lstatSync(directoryPath,{throwIfNoEntry:false})){
    if(existingOnly)throw Error('initial-stage-missing');
    const tmp=join(parent,'.preparing-'+randomUUID()),created=[];mkdirSync(tmp,{mode:0o700});
    let moved=false;
    try {
      for(const {name,text} of files)if(text!==null){const path=join(tmp,name);writeFileSync(path,text,{flag:'wx',mode:0o600});created.push(path);}
      matches(tmp,hashes);
      // Concurrent constructors can only publish the same complete tree. Never merge individual files.
      try{renameSync(tmp,directoryPath);moved=true;}catch(e){if(!lstatSync(directoryPath,{throwIfNoEntry:false}))throw e;}
    }finally{if(!moved){for(const p of created)unlinkSync(p);rmdirSync(tmp);}}
  }
  matches(directoryPath,hashes);
  const again=originalTextMaterial(co,host,ticketId);if(!same(initial,again))throw Error('initial-stage-material-changed');
  return {ready:true,ticketId,contractSha256:initial.contractSha256,requestSha256,candidateSha256,directory:directoryPath,files:hashes};
}
