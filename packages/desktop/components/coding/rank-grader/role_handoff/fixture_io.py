"""Fixed role fixture primitives. Only disposable paths supplied by the fixture controller."""
import _winapi
import hashlib
import json
import msvcrt
import os
import sys
from pathlib import Path


def encoded(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':')).encode('ascii')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def io(path, mode, data=b''):
    # Use the native open so that ACCESS_DENIED and FILE_NOT_FOUND retain different winerror values.
    access, disposition = {'read': (0x80000000, 3), 'replace': (0x40000000, 5),
                           'create': (0x40000000, 1)}[mode]
    h = _winapi.CreateFile(str(path), access, 7, 0, disposition, 0x80, 0)
    fd = msvcrt.open_osfhandle(h, os.O_BINARY | (os.O_RDONLY if mode == 'read' else os.O_WRONLY))
    with os.fdopen(fd, 'rb' if mode == 'read' else 'wb') as f:
        if mode == 'read':
            return f.read()
        return f.write(data)


class Fixture:
    def __init__(self):
        args = json.load(sys.stdin)
        self.root = Path(args['fixture']); self.variant = args['variant']
        self.results = {}

    def check(self, name, op):
        try:
            self.results[name] = {'value': op()}
        except OSError as exc:
            self.results[name] = {'winerror': getattr(exc, 'winerror', None), 'errno': exc.errno}

    def common(self):
        r = self.root
        self.check('contract', lambda: digest(io(r/'public'/'contract.json', 'read')))
        self.check('knownMissing', lambda: digest(io(r/'public'/'missing', 'read')))
        self.check('readOriginal', lambda: digest(io(r/'original'/'overwrite', 'read')))
        self.check('readCredential', lambda: digest(io(r/'controller'/'credential', 'read')))
        for group in ('controller', 'original'):
            self.check(group+'.overwrite', lambda: io(r/group/'overwrite', 'replace', b'changed'))
            self.check(group+'.delete', lambda: (r/group/'delete').unlink())
            self.check(group+'.rename', lambda: (r/group/'rename').rename(r/group/'renamed') and True)
        self.check('forgeReceipt', lambda: io(r/'controller'/'forged', 'create', b'forged'))

    def finish(self):
        print(json.dumps({'pid': os.getpid(), 'ops': self.results}))
