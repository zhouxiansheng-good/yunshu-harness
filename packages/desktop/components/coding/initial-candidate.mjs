/** Candidate custody only. The ticket, not a file's presence, publishes a result. */
import {createHash} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readDiagnosisSource} from './diagnosis-input.mjs';
import {parseDiagnosisJson} from './diagnosis-json.mjs';
import {validateFreshCandidate} from './candidate-wire.mjs';

const maxBytes=512*1024; // The complete HTTP response is already capped at this size.
const digest = s => typeof s==='string' && s.length===64 && /^[0-9a-f]+$/.test(s);
const fail = reason => {throw Error(reason);};
function pathFor(stateDir,binding,create) {
  // binding is recomputed from the host's approved assignment, never taken from an artifact path.
  const dir=join(stateDir,'initial-candidates');
  if(create) try {mkdirSync(dir,{mode:0o700});} catch(error) {if(error.code!=='EEXIST') throw error;}
  const st=lstatSync(dir);
  if(!st.isDirectory() || st.isSymbolicLink() || realpathSync(dir)!==dir) fail('initial-candidate-directory-invalid');
  return join(dir,`${binding.ticketId}.${binding.requestSha256}.json`);
}
export function storeInitialCandidate(stateDir,binding,candidate) {
  const bytes=Buffer.from(JSON.stringify(candidate),'utf8');
  if(bytes.length>maxBytes) fail('initial-candidate-size-invalid');
  const ref={schema:1,ticketId:binding.ticketId,attemptId:binding.attemptId,requestSha256:binding.requestSha256,
    sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
  // Exclusive create: even a partial or orphaned artifact must never be replaced or adopted.
  const fd=openSync(pathFor(stateDir,binding,true),'wx',0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
  return ref;
}
export function loadInitialCandidate(stateDir,binding,manifest,probe) {
  const r=probe.candidateRef;
  if(!r || typeof r!=='object' || Object.keys(r).sort().join(',')!=='attemptId,bytes,requestSha256,schema,sha256,ticketId' ||
    r.schema!==1 || r.ticketId!==binding.ticketId || r.attemptId!==binding.attemptId || r.requestSha256!==binding.requestSha256 ||
    !digest(r.sha256) || r.sha256!==probe.candidateSha256 || !Number.isSafeInteger(r.bytes) || r.bytes<1 || r.bytes>maxBytes)
    fail('initial-candidate-reference-mismatch');
  let artifact;
  try {
    const path=pathFor(stateDir,binding,false),st=lstatSync(path);
    if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || st.size!==r.bytes) fail('initial-candidate-integrity');
    artifact=readDiagnosisSource(path,maxBytes);
  } catch(error) {fail(error.code==='ENOENT'?'initial-candidate-missing':'initial-candidate-integrity');}
  if(artifact.sha256!==r.sha256 || artifact.bytes!==r.bytes) fail('initial-candidate-integrity');
  const expected={ticketId:binding.ticketId,attemptId:binding.attemptId,manifestSha256:binding.manifestSha256,contractSha256:manifest.contractSha256};
  let candidate;
  try {candidate=validateFreshCandidate(parseDiagnosisJson(artifact.text),{binding:expected,files:manifest.files});}
  catch {fail('initial-candidate-content-invalid');}
  if(candidate.result!=='candidate' || JSON.stringify(candidate)!==artifact.text) fail('initial-candidate-format');
  return candidate;
}
