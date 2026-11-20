import {createHash} from 'node:crypto';
// Public reference IDs only. The transcript, request text and model reasoning are not a dependency ledger.
const hashId=/^[a-f0-9]{64}$/, roundId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxEdges=256, maxBackup=100000;
const valid=(kind,id)=>kind==='source'?hashId.test(id):['round','user-round'].includes(kind)?roundId.test(id):['known','opaque'].includes(kind)&&id==='';
const check=(ok)=>{if(!ok)throw Error('Invalid memory answer lineage');};

// Take only the committed request surface, not a search pool or a preview assembly.
// Non-host user text which looks like JSON cannot create edges. Same-session assistant messages
// are linked to their exact previous completed round, rather than guessed from their wording.
export function basisAtAnswer(session,event){
  if(event.type!=='assistant/message'||event.data?.interrupted||!session?.deriveMessages)return null;
  try{
    const messages=session.deriveMessages(), refs=[], prior=new Set();let host=false;
    for(const m of messages){
      if(m.role==='assistant'){
        const calls=m.content?.filter(p=>p.type==='tool-call')??[];
        if(calls.some(p=>/^yunshu_memory/.test(p.name)))return [['opaque','']];
        if(!calls.length&&m.id!==event.data?.message?.id)prior.add(m.id);
        continue;
      }
      if(m.role==='tool'&&/^yunshu_memory/.test(m.toolName??m.name??''))return [['opaque','']];
      const system=m.role==='system'&&m.source?.kind==='system-prompt';
      const snapshot=m.role==='user'&&['yunshu-persona','runtime-context'].includes(m.source?.kind);
      if(!system&&!snapshot)continue;
      host=true;
      const chunks=system?m.content.filter(x=>x.type==='text').map(x=>x.text):(m.source.sections??[]).filter(s=>s.name==='yunshu-reference').map(s=>s.text);
      for(const text of chunks)for(const line of text.split(/\r?\n/)){
        if(!line.startsWith('{')||!line.includes('"type":"yunshu_reference_data"'))continue;
        const packet=JSON.parse(line);if(packet.type!=='yunshu_reference_data'||packet.instructions!==false||!Array.isArray(packet.records))continue;
        for(const record of packet.records){
          if(record.historical===true){if(!roundId.test(record.id))return [['opaque','']];refs.push([record.user_input_only?'user-round':'round',record.id]);}
          if(hashId.test(record.source_id))refs.push(['source',record.source_id]);
        }
      }
    }
    if(!host)return null;
    if(prior.size){
      for(const e of session.snapshotEvents?.()??[]){const id=e.data?.message?.id;
        if(e.type==='assistant/message'&&prior.delete(id))refs.push(['prior',e.seq]);}
      if(prior.size)return [['opaque','']];
    }
    return refs.length>maxEdges?[['opaque','']]:refs;
  }catch{return [['opaque','']];}
}

export class RecallLineage{
  constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS yunshu_answer_basis(
    child TEXT NOT NULL REFERENCES conversation_rounds(id),kind TEXT NOT NULL,ref TEXT NOT NULL,
    PRIMARY KEY(child,kind,ref));CREATE INDEX IF NOT EXISTS yunshu_answer_basis_parent ON yunshu_answer_basis(kind,ref,child);`);}
  bind(scope,session,child,refs){
    if(refs==null)return; // old/manual archives have no trustworthy request receipt
    const put=this.db.prepare('INSERT OR IGNORE INTO yunshu_answer_basis VALUES(?,?,?)');
    const older=this.db.prepare('SELECT id FROM conversation_rounds WHERE scope=? AND session_id=? AND end_seq=?');
    const pairs=refs.length>maxEdges?[['opaque','']]:refs;
    put.run(child,'known','');
    for(let [kind,id] of pairs){
      if(kind==='prior'){const r=older.get(scope,session,id);[kind,id]=r&&r.id!==child?['round',r.id]:['opaque',''];}
      check(valid(kind,id));put.run(child,kind,id);
    }
  }
  status(scope){
    // UNION (not UNION ALL) visits each blocked round once, even for a diamond. Reverse edge index
    // propagates invalidation to descendants; a missing inter-project parent is not current evidence.
    const rows=this.db.prepare(`WITH RECURSIVE retired(id) AS (
      SELECT id FROM yunshu_sources WHERE withdrawn=1 UNION SELECT source_id FROM yunshu_observations WHERE state IN ('withdrawn','superseded')
    ), bad(id) AS (
      SELECT id FROM conversation_rounds WHERE deleted=1
      UNION SELECT r.id FROM retired t JOIN yunshu_sources s ON s.id=t.id JOIN conversation_rounds r ON r.scope=s.scope AND r.session_id=s.session_id AND s.event_seq BETWEEN r.start_seq AND r.end_seq
      UNION SELECT b.child FROM yunshu_answer_basis b LEFT JOIN yunshu_sources s ON s.id=b.ref LEFT JOIN retired t ON t.id=b.ref WHERE b.kind='source' AND (s.id IS NULL OR t.id IS NOT NULL)
      UNION SELECT b.child FROM yunshu_answer_basis b LEFT JOIN conversation_rounds r ON r.id=b.ref WHERE b.kind IN ('round','user-round') AND r.id IS NULL
      UNION SELECT b.child FROM yunshu_answer_basis b JOIN conversation_rounds r ON r.id=b.ref
        WHERE b.kind='round' AND NOT EXISTS(SELECT 1 FROM yunshu_answer_basis x WHERE x.child=r.id AND x.kind='known')
        AND EXISTS(SELECT 1 FROM retired t JOIN yunshu_sources s ON s.id=t.id WHERE s.scope=r.scope)
      UNION SELECT child FROM yunshu_answer_basis WHERE kind='opaque'
      UNION SELECT b.child FROM bad JOIN yunshu_answer_basis b ON b.kind IN ('round','user-round') AND b.ref=bad.id
    ) SELECT r.id,EXISTS(SELECT 1 FROM yunshu_answer_basis b WHERE b.child=r.id AND b.kind='known') AS known,
      EXISTS(SELECT 1 FROM bad WHERE bad.id=r.id) AS blocked FROM conversation_rounds r WHERE r.scope=?`).all(scope);
    return new Map(rows.map(r=>[r.id,r]));
  }
  export(scope){const rows=this.db.prepare(`SELECT b.child,b.kind,b.ref FROM yunshu_answer_basis b JOIN conversation_rounds r ON r.id=b.child WHERE r.scope=? ORDER BY b.child,b.kind,b.ref LIMIT ?`).all(scope,maxBackup+1);check(rows.length<=maxBackup);return rows;}
  restore(rows,rounds){
    if(rows===undefined)return;check(Array.isArray(rows)&&rows.length>0&&rows.length<=maxBackup);
    const ids=new Set(rounds.map(r=>r.id)), grouped=new Map(), marked=new Set(), graph=new Map(), indegree=new Map();
    for(const r of rows){check(r&&ids.has(r.child)&&typeof r.ref==='string'&&valid(r.kind,r.ref));
      const n=(grouped.get(r.child)??0)+1;check(n<=maxEdges+1);grouped.set(r.child,n);if(r.kind==='known')marked.add(r.child);
      if(['round','user-round'].includes(r.kind)&&ids.has(r.ref)){if(!graph.has(r.ref))graph.set(r.ref,[]);graph.get(r.ref).push(r.child);indegree.set(r.child,(indegree.get(r.child)??0)+1);}}
    check([...grouped.keys()].every(id=>marked.has(id)));const queue=[...ids].filter(id=>!indegree.has(id));
    for(let i=0;i<queue.length;i++)for(const c of graph.get(queue[i])??[]){const n=indegree.get(c)-1;indegree.set(c,n);if(!n)queue.push(c);}check(queue.length===ids.size);
    const put=this.db.prepare('INSERT INTO yunshu_answer_basis VALUES(?,?,?)');for(const r of rows)put.run(r.child,r.kind,r.ref);
  }
}
const digest=(scope,rows)=>createHash('sha256').update(JSON.stringify([scope,rows.map(r=>[r.child,r.kind,r.ref])])).digest('hex');
export function lineageHeader(scope,baseSchemaVersion,answerBasis){return answerBasis.length?{schemaVersion:5,baseSchemaVersion,answerBasis,answerBasisHash:digest(scope,answerBasis)}:{};}
export function unwrapLineage(packet){
  if(packet?.schemaVersion!==5){check(packet?.answerBasis===undefined&&packet?.baseSchemaVersion===undefined&&packet?.answerBasisHash===undefined);return {packet};}
  check([3,4].includes(packet.baseSchemaVersion)&&Array.isArray(packet.answerBasis)&&packet.answerBasis.length>0&&packet.answerBasis.length<=maxBackup&&packet.answerBasisHash===digest(packet.scope,packet.answerBasis));
  const {answerBasis,baseSchemaVersion,...base}=packet;return {packet:{...base,schemaVersion:baseSchemaVersion},rows:answerBasis};
}
