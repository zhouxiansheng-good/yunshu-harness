"""Windows 10+ offline fixture host. Ephemeral per-user profile; no machine ACL change or ordinary fallback."""
import contextlib
import ctypes as C
from ctypes import wintypes as W
import json
import msvcrt
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
import ntsecuritycon as nt
import win32api
import win32job as job
import win32security as sec

P, D, H, Z = C.c_void_p, W.DWORD, W.HANDLE, C.c_size_t
k = C.WinDLL('kernel32', use_last_error=True)
a = C.WinDLL('advapi32', use_last_error=True)
u = C.WinDLL('userenv', use_last_error=True)

def api(dll, name, result, *args):
    fn = getattr(dll, name); fn.argtypes = args; fn.restype = result; return fn

class SI(C.Structure):
    _fields_ = [('cb',D), ('reserved',P), ('desktop',P), ('title',P)] + [(x,D) for x in
        ('x','y','xs','ys','xc','yc','fill','flags')] + [('show',W.WORD),('res2',W.WORD),('ptr',P),('stdin',H),('stdout',H),('stderr',H)]
class SIEX(C.Structure): _fields_ = [('si',SI),('attrs',P)]
class PI(C.Structure): _fields_ = [('process',H),('thread',H),('pid',D),('tid',D)]
class Caps(C.Structure): _fields_ = [('sid',P),('groups',P),('count',D),('reserved',D)]

init=api(k,'InitializeProcThreadAttributeList',W.BOOL,P,D,D,C.POINTER(Z)); add=api(k,'UpdateProcThreadAttribute',W.BOOL,P,D,Z,P,Z,P,P)
drop=api(k,'DeleteProcThreadAttributeList',None,P); create=api(k,'CreateProcessW',W.BOOL,W.LPCWSTR,W.LPWSTR,P,P,W.BOOL,D,P,W.LPCWSTR,P,C.POINTER(PI))
close=api(k,'CloseHandle',W.BOOL,H); resume=api(k,'ResumeThread',D,H); wait=api(k,'WaitForSingleObject',D,H,D)
exitcode=api(k,'GetExitCodeProcess',W.BOOL,H,C.POINTER(D)); in_job=api(k,'IsProcessInJob',W.BOOL,H,H,C.POINTER(W.BOOL))
peek=api(k,'PeekNamedPipe',W.BOOL,H,P,D,P,C.POINTER(D),P)
open_token=api(a,'OpenProcessToken',W.BOOL,H,D,C.POINTER(H)); token_info=api(a,'GetTokenInformation',W.BOOL,H,C.c_int,P,D,C.POINTER(D))
equal_sid=api(a,'EqualSid',W.BOOL,P,P); derive=api(u,'DeriveAppContainerSidFromAppContainerName',C.c_long,W.LPCWSTR,C.POINTER(P));free_sid=api(a,'FreeSid',P,P)
make_profile=api(u,'CreateAppContainerProfile',C.c_long,W.LPCWSTR,W.LPCWSTR,W.LPCWSTR,P,D,C.POINTER(P));delete_profile=api(u,'DeleteAppContainerProfile',C.c_long,W.LPCWSTR)
sid_len=api(a,'GetLengthSid',D,P)

def ok(value, name):
    if not value: raise OSError(f'{name}: {C.WinError(C.get_last_error())}')

def fields(token, kind):
    size=D();token_info(token,kind,None,0,C.byref(size));ok(size.value,'token size '+str(kind))
    buf=C.create_string_buffer(size.value);ok(token_info(token,kind,buf,size,C.byref(size)),'token info '+str(kind));return buf

def attest(process,sid,j):
    inside=W.BOOL();ok(in_job(process,int(j),C.byref(inside)),'IsProcessInJob')
    h=H();ok(open_token(process,8,C.byref(h)),'OpenProcessToken')
    try:
        identity=fields(h,31);ptr=P.from_buffer(identity).value
        lp=D();got=D();has_lp=token_info(h,46,C.byref(lp),C.sizeof(lp),C.byref(got))
        if not has_lp and C.get_last_error()!=87:ok(False,'TokenIsLessPrivilegedAppContainer')
        info={'appContainer':D.from_buffer(fields(h,29)).value,
              'capabilities':D.from_buffer(fields(h,30)).value,'sameSid':bool(ptr and equal_sid(sid,ptr)),'inJob':bool(inside)}
        if info!={'appContainer':1,'capabilities':0,'sameSid':True,'inJob':True}:raise RuntimeError(f'token/job mismatch: {info}')
        info['kernelLessPrivilegedQuery']=lp.value if has_lp else None
        return info
    finally:close(h)

def check_policy(policy, kernel_report):
    # Unsupported token info is not proof of LPAC. Never resume if the caller required the stronger policy.
    if policy=='lpac-zero' and kernel_report!=1:raise RuntimeError('required LPAC token not independently confirmed; child not resumed')
    if policy=='appcontainer-zero' and kernel_report not in (0,None):raise RuntimeError('unexpected token isolation policy; child not resumed')

def acl(folder,owner,role=None,mask=0):
    d=sec.ACL(); inherit=3 if folder.is_dir() else 0
    d.AddAccessAllowedAceEx(sec.ACL_REVISION,inherit,nt.FILE_ALL_ACCESS,owner)
    if role is not None:d.AddAccessAllowedAceEx(sec.ACL_REVISION,inherit,mask,role)
    sec.SetNamedSecurityInfo(str(folder),sec.SE_FILE_OBJECT,sec.DACL_SECURITY_INFORMATION|sec.PROTECTED_DACL_SECURITY_INFORMATION,None,None,d,None)

@contextlib.contextmanager
def environment():
    if sys.version_info[:2]!=(3,12) or C.sizeof(P)!=8:raise RuntimeError('fixture runtime requires 64-bit CPython 3.12')
    name='yunshu-fixture-'+uuid.uuid4().hex;sid=P();hr=make_profile(name,name,'Ephemeral Yunshu offline calibration',None,0,C.byref(sid))
    if hr:raise RuntimeError(f'CreateAppContainerProfile HRESULT 0x{hr&0xffffffff:08x}')
    try:
        role=sec.SID(C.string_at(sid,sid_len(sid)));token=sec.OpenProcessToken(win32api.GetCurrentProcess(),sec.TOKEN_QUERY)
        try:owner=sec.GetTokenInformation(token,sec.TokenUser)[0]
        finally:token.Close()
        base=Path(tempfile.gettempdir()).resolve()
        with tempfile.TemporaryDirectory(prefix='yunshu-lpac-',dir=base) as td:
            root=Path(td).resolve();assert root.parent==base and root.name.startswith('yunshu-lpac-')
            acl(root,owner);rt=root/'runtime';work=root/'work';priv=root/'controller'
            for directory in (rt,work,priv):directory.mkdir()
            # Grant traverse only on the disposable parent; never touch the installed interpreter or project ACLs.
            acl(root,owner,role,nt.FILE_TRAVERSE);acl(priv,owner);acl(rt,owner,role,nt.FILE_GENERIC_READ|nt.FILE_GENERIC_EXECUTE);acl(work,owner,role,nt.FILE_GENERIC_READ|nt.FILE_GENERIC_EXECUTE)
            host=Path(sys.base_prefix);exe=rt/'python.exe'
            for n in ['python.exe','python312.dll','vcruntime140.dll','vcruntime140_1.dll']:shutil.copyfile(host/n,rt/n)
            for n in ['_socket.pyd','select.pyd','unicodedata.pyd']:shutil.copyfile(host/'DLLs'/n,rt/n)
            # Isolated, uncompressed stdlib (no dynamic zlib dependency and no site packages).
            lib=host/'Lib';skip={'__pycache__','site-packages','test','tests','idlelib','tkinter','turtledemo','ensurepip','lib2to3'}
            with zipfile.ZipFile(rt/'python312.zip','x') as z:
                for parent,dirs,files in os.walk(lib):
                    dirs[:]=sorted(x for x in dirs if x not in skip)
                    for n in sorted(files):
                        if n.endswith('.py'):
                            f=Path(parent)/n;z.write(f,f.relative_to(lib).as_posix())
            (rt/'python312._pth').write_text('python312.zip\n.\n',encoding='ascii')
            yield {'sid':sid,'sidText':sec.ConvertSidToStringSid(role),'root':root,'rt':rt,'work':work,'private':priv,'exe':exe}
    finally:
        free_sid(sid);hr=delete_profile(name)
        if hr:raise RuntimeError(f'clean up owned profile {name}: HRESULT 0x{hr&0xffffffff:08x}')

def run(env, argv, data, *, policy, deadline=5, limit=65536):
    """For the fixture harness only; verify kernel identity before any user-mode instruction."""
    if policy not in ('appcontainer-zero','lpac-zero'):raise ValueError('explicit isolation policy required')
    body=json.dumps(data,ensure_ascii=False).encode();
    if len(body)>2048:raise ValueError('single probe input cap')
    with contextlib.ExitStack() as st:
        j=job.CreateJobObject(None,'');st.callback(j.Close)
        limits=job.QueryInformationJobObject(j,job.JobObjectExtendedLimitInformation);basic=limits['BasicLimitInformation'];basic['LimitFlags']=job.JOB_OBJECT_LIMIT_ACTIVE_PROCESS|job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|job.JOB_OBJECT_LIMIT_JOB_MEMORY;basic['ActiveProcessLimit']=1;limits['JobMemoryLimit']=128*1024**2;job.SetInformationJobObject(j,job.JobObjectExtendedLimitInformation,limits)
        # Only three anonymous pipe ends can be inherited; no host tokens, files, sockets or job handles.
        def pipe():
            r,w=os.pipe();return st.enter_context(os.fdopen(r,'rb',0)),st.enter_context(os.fdopen(w,'wb',0))
        ir,iw=pipe();out,ow=pipe();err,ew=pipe();iw.write(body);iw.close()
        handles=[msvcrt.get_osfhandle(f.fileno()) for f in (ir,ow,ew)]
        for h in handles:os.set_handle_inheritable(h,True)
        attrs={0x20002:(H*3)(*handles),0x20009:Caps(env['sid'],None,0,0),0x2000d:(H*1)(int(j)),0x2000f:D(int(policy=='lpac-zero'))}
        n=Z();init(None,len(attrs),0,C.byref(n));buf=C.create_string_buffer(n.value);ok(init(buf,len(attrs),0,C.byref(n)),'InitializeProcThreadAttributeList');st.callback(drop,buf)
        for key,v in attrs.items():ok(add(buf,0,key,C.byref(v),C.sizeof(v),None,None),'UpdateProcThreadAttribute '+hex(key))
        si=SIEX();si.si.cb=C.sizeof(si);si.si.flags=0x100;si.si.stdin,si.si.stdout,si.si.stderr=handles;si.attrs=C.addressof(buf);pi=PI()
        environ=C.create_unicode_buffer('\0'.join(k+'='+os.environ[k] for k in ('APPDATA','LOCALAPPDATA','SystemRoot','USERPROFILE','WINDIR'))+'\0\0')
        cmd=C.create_unicode_buffer(subprocess.list2cmdline([str(env['exe']),'-I','-S','-B','-X','utf8',*map(str,argv)]))
        ok(create(str(env['exe']),cmd,None,None,True,0x08080404,environ,str(env['work']),C.byref(si),C.byref(pi)),'CreateProcessW(LPAC)')
        st.callback(close,pi.process);st.callback(close,pi.thread)
        try:
            ir.close();ow.close();ew.close();proof=attest(pi.process,env['sid'],j);proof['policy']=policy
            check_policy(policy,proof['kernelLessPrivilegedQuery'])
            if resume(pi.thread)!=1:raise RuntimeError('unexpected initial suspend count')
            streams=[bytearray(),bytearray()];end=time.monotonic()+deadline
            def drain():
                for f,acc in zip((out,err),streams):
                    count=D();success=peek(msvcrt.get_osfhandle(f.fileno()),None,0,None,C.byref(count),None)
                    if not success and C.get_last_error() not in (109,232):ok(False,'PeekNamedPipe')
                    if success and count.value:
                        if len(acc)+count.value>limit:raise ValueError('worker output cap')
                        acc.extend(f.read(count.value))
            while True:
                drain();rc=wait(pi.process,5)
                if rc==0:break
                if rc!=258:ok(False,'WaitForSingleObject')
                if time.monotonic()>end:raise TimeoutError('worker deadline')
            drain();code=D();ok(exitcode(pi.process,C.byref(code)),'GetExitCodeProcess')
            if code.value:raise RuntimeError(f'worker exit 0x{code.value:08x}: {bytes(streams[1])[:500]!r}')
            value=json.loads(streams[0]);return value,dict(proof,pid=pi.pid)
        finally:
            # Also handles failures during attestation, while the child is still suspended.
            job.TerminateJobObject(j,123); wait(pi.process,3000)
            if job.QueryInformationJobObject(j,job.JobObjectBasicAccountingInformation)['ActiveProcesses']!=0:raise RuntimeError('job not empty after teardown')
