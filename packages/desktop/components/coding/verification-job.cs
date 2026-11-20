// Windows 10+ verification supervisor. No shell; the workload enters its Job
// atomically at CreateProcess, before its suspended first thread can execute.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class VerificationJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr security; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show, reservedSize;
    public IntPtr reservedPointer, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr min,max;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong rOps,wOps,oOps,rBytes,wBytes,oBytes; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC_LIMIT basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref LIMIT info,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT info,uint size,IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static volatile string control;
  static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Text(object value) {
    if(!(value is string) || ((string)value).IndexOf('\0')>=0) throw new ArgumentException("command text contains NUL or is not a string");
  }
  static string Digest(string path) { using(var s=File.OpenRead(path)) using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(s)).Replace("-","").ToLowerInvariant(); }
  static object FreezeOutputs(string directory,Dictionary<string,object> result) {
    var clock=Stopwatch.StartNew();
    try {
      for(;;) {
        try {
          // Job accounting may reach zero just before Windows releases the last
          // terminated process' inherited output handles. Require exclusive
          // read sharing, not a permissive read of still-writable bytes.
          using(var output=File.OpenRead(Path.Combine(directory,"stdout.log")))
          using(var error=File.OpenRead(Path.Combine(directory,"stderr.log"))) {
            var files=new Dictionary<string,object>();
            foreach(var pair in new Dictionary<string,FileStream>{{"stdout.log",output},{"stderr.log",error}}) {
              using(var h=SHA256.Create()) files[pair.Key]=new Dictionary<string,object>{{"bytes",pair.Value.Length},
                {"sha256",BitConverter.ToString(h.ComputeHash(pair.Value)).Replace("-","").ToLowerInvariant()}};
            }
            return files;
          }
        } catch(IOException) {if(clock.ElapsedMilliseconds>=2000) throw;Thread.Sleep(10);}
      }
    } finally {result["outputBindingWaitMs"]=clock.ElapsedMilliseconds;}
  }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes);
      slashes=0; b.Append(c);
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  static uint Active(IntPtr job) { ACCOUNT a; Require(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)); return a.active; }
  static string RootExitReason(IntPtr job,uint exit,Stopwatch workload,long timeout,long grace,long maxOutput,string directory,Dictionary<string,object> result) {
    var waiting=Stopwatch.StartNew(); int polls=0;
    try {
      for(;;) {
        polls++;
        if(control!=null) return control;
        if(workload.ElapsedMilliseconds>=timeout) return "timeout";
        if(new FileInfo(Path.Combine(directory,"stdout.log")).Length>maxOutput || new FileInfo(Path.Combine(directory,"stderr.log")).Length>maxOutput) return "output-limit";
        if(Active(job)==0) return exit==0 ? "completed" : "failed";
        // A small, request-bound natural drain covers console-host teardown and
        // short finite children. No process-name whitelist, no success after kill.
        if(waiting.ElapsedMilliseconds>=grace) return "descendants-after-root-exit";
        Thread.Sleep(1);
      }
    } finally { result["rootExitAccountingPolls"]=polls;result["rootExitAccountingWaitMs"]=waiting.ElapsedMilliseconds; }
  }
  static bool EmptyAfterStop(IntPtr job) {
    Require(TerminateJobObject(job,125)); var clock=Stopwatch.StartNew();
    while(clock.ElapsedMilliseconds<10000) { if(Active(job)==0) return true; Thread.Sleep(10); }
    return false;
  }
  static void Close(ref IntPtr p) { if(p!=IntPtr.Zero && p!=new IntPtr(-1)) CloseHandle(p); p=IntPtr.Zero; }
  static int Main(string[] args) {
    if(args.Length!=1 && args.Length!=2) return 2;
    var json=new JavaScriptSerializer(); json.MaxJsonLength=1024*1024;
    string request=Path.GetFullPath(args[0]);
    byte[] requestBytes=File.ReadAllBytes(request);string requestHash;
    using(var h=SHA256.Create()) requestHash=BitConverter.ToString(h.ComputeHash(requestBytes)).Replace("-","").ToLowerInvariant();
    // A changed request must not execute first and fail only on receipt readback.
    if(args.Length==2 && args[1]!=requestHash) return 3;
    var input=json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(requestBytes).TrimStart('\uFEFF'));
    string directory=Path.GetDirectoryName(request), receipt=Path.Combine(directory,"receipt.json");
    // One workload per frozen request, including direct helper invocations.
    // A lost owner/claim is unknown, not permission to replay side effects.
    try {
      using(var claim=new FileStream(Path.Combine(directory,"supervisor-launch.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read))
      using(var writer=new StreamWriter(claim,new UTF8Encoding(false))) writer.Write(json.Serialize(new {requestSha256=requestHash,pid=Process.GetCurrentProcess().Id}));
    } catch(IOException) {return 4;}
    var result=new Dictionary<string,object> {
      {"protocol",1},{"checkId",input["checkId"]},{"nonce",input["nonce"]},{"jobName",input["jobName"]},
      {"requestSha256",requestHash},{"supervisorSha256",Digest(Assembly.GetExecutingAssembly().Location)},
      {"terminalVerified",false},{"assignedBeforeResume",false},{"rootExitCode",null},
      {"reason","setup-error"},{"supervisorPid",Process.GetCurrentProcess().Id}
    };
    IntPtr job=IntPtr.Zero, attrs=IntPtr.Zero, jobArray=IntPtr.Zero, handleArray=IntPtr.Zero;
    IntPtr output=IntPtr.Zero,error=IntPtr.Zero,stdin=IntPtr.Zero,environment=IntPtr.Zero;
    PI child=new PI(); bool attributesReady=false, ownJob=false;
    try {
      // Defense in depth for direct helper calls and older persisted requests.
      Text(input["program"]);Text(input["cwd"]);
      foreach(object arg in (ArrayList)input["args"]) Text(arg);
      long rootGrace=input.ContainsKey("rootExitGraceMs") ? Convert.ToInt64(input["rootExitGraceMs"]) : 0;
      if(rootGrace<0 || rootGrace>2000) throw new ArgumentException("rootExitGraceMs must be 0..2000");
      result["rootExitGraceMs"]=rootGrace;
      job=CreateJobObject(IntPtr.Zero,(string)input["jobName"]);
      int creationError=Marshal.GetLastWin32Error();
      Require(job!=IntPtr.Zero);
      if(creationError==183) throw new InvalidOperationException("job-name-already-exists");
      ownJob=true;
      var limits=new LIMIT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(LIMIT))));
      var security=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=1 };
      output=CreateFile(Path.Combine(directory,"stdout.log"),0x40000000,3,ref security,1,0,IntPtr.Zero);
      error=CreateFile(Path.Combine(directory,"stderr.log"),0x40000000,3,ref security,1,0,IntPtr.Zero);
      stdin=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
      Require(output!=new IntPtr(-1) && error!=new IntPtr(-1) && stdin!=new IntPtr(-1));
      IntPtr size=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      attrs=Marshal.AllocHGlobal(size); Require(InitializeProcThreadAttributeList(attrs,2,0,ref size)); attributesReady=true;
      jobArray=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobArray,job);
      // Atomic job assignment removes the crash window between creation/assignment.
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000D),jobArray,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      handleArray=Marshal.AllocHGlobal(IntPtr.Size*3);
      Marshal.WriteIntPtr(handleArray,0,stdin);Marshal.WriteIntPtr(handleArray,IntPtr.Size,output);Marshal.WriteIntPtr(handleArray,IntPtr.Size*2,error);
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handleArray,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      var startup=new SIX(); startup.si.cb=Marshal.SizeOf(typeof(SIX)); startup.si.flags=0x100;
      startup.si.stdin=stdin; startup.si.stdout=output;startup.si.stderr=error;startup.attributes=attrs;
      var command=new StringBuilder(Quote((string)input["program"]));
      foreach(object arg in (ArrayList)input["args"]) command.Append(' ').Append(Quote((string)arg));
      var listener=new Thread(delegate() { try { string line=Console.ReadLine(); control=line=="cancel" ? "cancelled" : "owner-disconnected"; } catch { control="owner-disconnected"; } });
      listener.IsBackground=true;listener.Start();
      if(control!=null) throw new InvalidOperationException(control);
      uint creationFlags=0x08080004;
      if(input.ContainsKey("environmentPolicy")) {
        if((string)input["environmentPolicy"]!="fresh-no-injection-v1") throw new ArgumentException("invalid environment policy");
        var clean=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(string key in new string[]{"SystemRoot","WINDIR","COMSPEC","TEMP","TMP","PATH","PATHEXT","OS"}) {
          string value=Environment.GetEnvironmentVariable(key);if(value!=null)clean[key]=value;
        }
        var block=new StringBuilder();foreach(var entry in clean)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');environment=Marshal.StringToHGlobalUni(block.ToString());creationFlags|=0x400;
        result["environmentPolicy"]="fresh-no-injection-v1";
      }
      // CREATE_NO_WINDOW preserves WinPS Console stdout/stderr. DETACHED_PROCESS
      // was tested and rejected: it silently discarded those streams on Win10.
      Require(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,creationFlags,environment,(string)input["cwd"],ref startup,out child));
      result["rootPid"]=child.pid;result["assignedBeforeResume"]=true;
      Require(ResumeThread(child.thread)!=0xFFFFFFFF);
      var clock=Stopwatch.StartNew(); long timeout=Convert.ToInt64(input["timeoutMs"]), maxOutput=Convert.ToInt64(input["maxOutputBytes"]);
      string reason=null;
      // O(1) process accounting. Descendants inherit the non-breakaway outer Job.
      for(;;) {
        if(control!=null) { reason=control; break; }
        if(clock.ElapsedMilliseconds>=timeout) { reason="timeout";break; }
        if(new FileInfo(Path.Combine(directory,"stdout.log")).Length>maxOutput || new FileInfo(Path.Combine(directory,"stderr.log")).Length>maxOutput) {reason="output-limit";break;}
        uint wait=WaitForSingleObject(child.process,0);
        if(wait==0) {
          uint exit;Require(GetExitCodeProcess(child.process,out exit));result["rootExitCode"]=exit;
          reason=RootExitReason(job,exit,clock,timeout,rootGrace,maxOutput,directory,result);
          break;
        }
        if(wait==0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
        Thread.Sleep(10);
      }
      // A passing parent is insufficient. Remaining children are stopped and the
      // check fails, rather than silently treating an unfinished test as passed.
      result["reason"]=reason;
      bool empty=Active(job)==0 || EmptyAfterStop(job);
      result["terminalVerified"]=empty;result["activeProcesses"]=Active(job);
    } catch(Exception ex) {
      result["error"]=ex.GetType().Name+": "+ex.Message;
      try { if(ownJob) {result["terminalVerified"]=Active(job)==0 || EmptyAfterStop(job);result["activeProcesses"]=Active(job);} } catch(Exception stop) {result["stopError"]=stop.Message;}
    } finally {
      Close(ref child.thread);Close(ref child.process);Close(ref output);Close(ref error);Close(ref stdin);
      if(attributesReady) DeleteProcThreadAttributeList(attrs);
      if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
      if(jobArray!=IntPtr.Zero) Marshal.FreeHGlobal(jobArray);
      if(handleArray!=IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
      if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
      Close(ref job);
    }
    // Freeze the actual output bytes only after the Job is empty and inherited
    // output handles have closed. Later edits must not become original evidence.
    if(result.ContainsKey("activeProcesses") && Convert.ToUInt32(result["activeProcesses"])==0) {
      try {
        result["outputFiles"]=FreezeOutputs(directory,result);
      } catch(Exception ex) { result["outputBindingError"]=ex.GetType().Name+": "+ex.Message; }
    }
    result["endedAt"]=DateTime.UtcNow.ToString("o");
    // Receipt is written only after process and output handles are closed.
    string temporary=receipt+"."+Process.GetCurrentProcess().Id+".new";
    File.WriteAllText(temporary,json.Serialize(result)+"\n",new UTF8Encoding(false));
    File.Move(temporary,receipt);
    return 0;
  }
}
