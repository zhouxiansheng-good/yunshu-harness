"""Run one fixed, offline AppContainer file exchange. No application profile, external code or network input."""
import argparse
import hashlib
import json
import secrets
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import ntsecuritycon as nt
import win32security as sec
import quality_lpac as box

HERE = Path(__file__).resolve().parent
FIX = HERE/'role_handoff'
READ = nt.FILE_GENERIC_READ | nt.FILE_GENERIC_EXECUTE


def encode(x):
    return json.dumps(x, separators=(',', ':'), sort_keys=True).encode('ascii')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def permissions(path, owner, grants, inherit=True):
    acl = sec.ACL()
    for sid, mask in [(owner, nt.FILE_ALL_ACCESS), *grants]:
        acl.AddAccessAllowedAceEx(sec.ACL_REVISION, 3 if inherit else 0, mask, sid)
    sec.SetNamedSecurityInfo(str(path), sec.SE_FILE_OBJECT, sec.DACL_SECURITY_INFORMATION |
                             sec.PROTECTED_DACL_SECURITY_INFORMATION, None, None, acl, None)


def snapshot(root):
    dirs, files = [], {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_dir():
            dirs.append(name)
        else:
            files[name] = sha(path.read_bytes())
    return {'dirs': dirs, 'files': files}


def prepare(envs, ticket):
    writer, judge = (sec.ConvertStringSidToSid(envs[r]['sidText']) for r in ('writer','judge'))
    token = sec.OpenProcessToken(box.win32api.GetCurrentProcess(), sec.TOKEN_QUERY)
    try:
        owner = sec.GetTokenInformation(token, sec.TokenUser)[0]
    finally:
        token.Close()
    host = envs['writer']['root']
    # Only the disposable parent gets a non-inheriting traversal grant. Runtime directories remain role-private.
    permissions(host, owner, [(writer, nt.FILE_TRAVERSE), (judge, nt.FILE_TRAVERSE)], False)
    root = host/'exchange'; root.mkdir()
    permissions(root, owner, [(writer, nt.FILE_TRAVERSE), (judge, nt.FILE_TRAVERSE)], False)
    for name, grants in [('drop', [(writer, READ | nt.FILE_GENERIC_WRITE), (judge, READ)]),
                         ('public', [(writer, READ), (judge, READ)]), ('private', [(judge, READ)]),
                         ('original', [(writer, READ), (judge, READ)]), ('controller', [])]:
        path = root/name; path.mkdir(); permissions(path, owner, grants)
    low = sec.ConvertStringSecurityDescriptorToSecurityDescriptor('S:(ML;OICI;NW;;;LW)', 1)
    sec.SetNamedSecurityInfo(str(root/'drop'), sec.SE_FILE_OBJECT, sec.LABEL_SECURITY_INFORMATION,
                             None, None, None, low.GetSecurityDescriptorSacl())
    contract = {'format': 'rank-list-v1', 'ticket': ticket, 'priority': ['urgent', 'normal', 'defer']}
    cases = [{'input':['defer','urgent','normal'], 'expected':['urgent','normal','defer']},
             {'input':['normal','defer','normal'], 'expected':['normal','normal','defer']}]
    (root/'public'/'contract.json').write_bytes(encode(contract)); (root/'private'/'cases.json').write_bytes(encode(cases))
    for group in ('original', 'controller'):
        for name in ('overwrite', 'delete', 'rename'):
            (root/group/name).write_bytes(secrets.token_bytes(24))
    (root/'controller'/'credential').write_bytes(secrets.token_bytes(32))  # fixture only
    return root, cases


def run(variant, record):
    native_delete = box.delete_profile
    def observed_delete(name):
        hr = native_delete(name); record['profileDeletes'].append({'name':name, 'hr':hr}); return hr
    roots = []
    try:
        with patch.object(box, 'delete_profile', observed_delete), ExitStack() as s:
            envs = {}
            for role in ('writer', 'judge'):
                env = envs[role] = s.enter_context(box.environment()); roots.append(env['root'])
                # Isolated ._pth includes only stdlib and this role's runtime. Never stage judge.py for the writer.
                for name in ('fixture_io.py', role+'.py'):
                    (env['rt']/name).write_bytes((FIX/name).read_bytes())
                record['roles'][role] = {'sid':env['sidText'], 'staged':sorted(p.name for p in env['rt'].glob('*.py'))}
            root, cases = prepare(envs, record['ticket']); record['cases'] = cases
            record['states'].append(snapshot(root))
            native_query = box.job.QueryInformationJobObject
            for role in ('writer', 'judge'):
                info = record['roles'][role]; info['endJobActive'] = []
                def observed_query(j, cls):
                    val = native_query(j, cls)
                    if cls == box.job.JobObjectBasicAccountingInformation:
                        info['endJobActive'].append(val['ActiveProcesses'])
                    return val
                arg = {'fixture': str(root), 'variant': variant if role == 'writer' else None}
                with patch.object(box.job,'QueryInformationJobObject',observed_query):
                    result, proof = box.run(envs[role], ['-m', role], arg, policy='appcontainer-zero', deadline=15)
                info.update(child=result, osProof=proof); record['states'].append(snapshot(root))
    finally:
        record['removed'] = [{'root':str(r), 'absent':not r.exists()} for r in roots]


def main():
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('variant', choices=['correct', 'reversed']); ap.add_argument('new_report',type=Path); args=ap.parse_args()
    if args.new_report.exists():
        raise FileExistsError(args.new_report)
    rec={'schema':1,'variant':args.variant, 'ticket':secrets.token_hex(12),'roles':{},'states':[], 'profileDeletes':[],
         'sources':{p.name:sha(p.read_bytes()) for p in [Path(__file__),Path(box.__file__), *sorted(FIX.glob('*.py'))]}}
    try:
        run(args.variant, rec)
    except Exception as exc:
        rec['error']=f'{type(exc).__name__}: {exc}'; raise
    finally:
        with args.new_report.open('x', encoding='utf-8') as out:
            json.dump(rec, out, indent=2, ensure_ascii=False); out.write('\n')
    print('Recorded', args.variant, 'pending independent verification')


if __name__ == '__main__':
    main()
