"""Fixed rank-list host: copy exact staged data, run the original private judge plus an export reader."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys
from contextlib import ExitStack

HERE = Path(__file__).resolve().parent
PINS = {'quality_lpac.py':'4e491f98f1fe2af45bfcc49aec6cd55174eceea66623605d29ebc171a5f95d45',
        'quality-role-handoff.py':'a548fcc62723b03a1ff4e2eb1780f2f5d008d8d5d4d16310c6fbaa2c339ef052',
        'role_handoff/fixture_io.py':'cbff2c04ab9640a0e470aa3ac1576df2828e4e046e90f27ef6f9a23b4d72e8c9',
        'role_handoff/judge.py':'3c28b44691ba4ab483a01f407a997a2cfcc7bd66ac619dc5c80b0ae0ead2202f',
        'role_export_judge.py':'45e2e64102c0b4ebc69cd848e114660d57008cd70773ccb3ffc1e2805d2cc154'}
def sha(b):return hashlib.sha256(b).hexdigest()
def require(value,label):
    if not value:raise ValueError(label)

def grade(s):
    require(all(sha((HERE/n).read_bytes())==v for n,v in PINS.items()),'grader source drift')
    sys.path.insert(0,str(HERE))  # isolated interpreter; trusted grader modules only
    host=runpy.run_path(str(HERE/'quality-role-handoff.py')); box=host['box']
    ticket=s['ticketId'];require(re.fullmatch(r'r-\d{14}-[0-9a-f]{4}_m-[0-9a-f]{10}',ticket),'unknown ticket format')
    folder=Path(s['directory']);require(folder.is_absolute() and folder.resolve()==folder and folder.name==ticket+'.'+s['candidateSha256'] and folder.parent.name=='initial-text-stages','stage location')
    require(set(s['files'])=={'candidate.json','order.txt'},'wrong targets'); data={}
    for n,h in s['files'].items():
        if h is None:continue
        p=folder/n;require(p.resolve()==p and p.is_file() and p.stat().st_nlink==1 and p.stat().st_size<=32768,'bad file')
        raw=p.read_bytes();require(sha(raw)==h,'stage bytes differ');data[n]=raw
    if len(data)!=2:return {'passed':False,'reason':'required-file-missing','files':s['files'],'proofs':[]}
    # Malformed data is a failed candidate, not a crashed scorer. Never import or evaluate supplied text.
    try:
        def obj(pairs):
            require(len(pairs)==len(dict(pairs)),'duplicate JSON fields');return dict(pairs)
        objdata=json.loads(data['candidate.json'].decode('utf-8'),object_pairs_hook=obj)
        require(type(objdata) is dict and set(objdata)=={'ticket','priority'} and isinstance(objdata['ticket'],str)
                and isinstance(objdata['priority'],list) and all(type(i) is str for i in objdata['priority']),'bad packet')
    except (ValueError,TypeError,RecursionError):return {'passed':False,'reason':'invalid-rank-json','files':s['files'],'proofs':[]}
    with ExitStack() as stack:
        env={k:stack.enter_context(box.environment()) for k in ('writer','judge')};j=env['judge'];root,cases=host['prepare'](env,ticket)
        # Only the known readers go on the import path. Candidate bytes live exclusively under drop/.
        for n in PINS:
            if n.startswith('role_handoff/') or n=='role_export_judge.py':(j['rt']/Path(n).name).write_bytes((HERE/n).read_bytes())
        for n,b in data.items():(root/'drop'/n).write_bytes(b)
        for n in ('delete','rename'):(root/'drop'/n).write_bytes(n.encode())
        before=host['snapshot'](root);info=[]
        for role in ('judge','role_export_judge'):
            child,proof=box.run(j,['-m',role],{'fixture':str(root),'variant':None},policy='appcontainer-zero',deadline=15)
            require(proof['pid']==child['pid'] and proof['pid']!=os.getpid() and proof['inJob'] and proof['sameSid'] and proof['capabilities']==0 and proof['appContainer']==1,'unattested child')
            ops=child['ops'];info.append({'role':role,'proof':proof,'readSha256':ops['readFinal' if role=='judge' else 'readExport']['value'],'passed':ops['verdict']['value']})
            if role=='judge':
                require(ops['drop.overwrite'].get('winerror')==5 and ops['readPrivate']['value']==before['files']['private/cases.json'],'grader reads/rights');info[-1]['observed']=ops['observed']['value']
        require(host['snapshot'](root)==before and [i['readSha256'] for i in info]==[s['files']['candidate.json'],s['files']['order.txt']],'scorer saw different bytes')
    return {'passed':all(i['passed'] is True for i in info),'reason':'measured','files':s['files'],'proofs':info,'sources':PINS}

if __name__=='__main__':
    line=sys.stdin.buffer.read(8193);require(len(line)<=8192,'input budget');print(json.dumps(grade(json.loads(line)),separators=(',',':')))
