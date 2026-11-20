"""Frozen data-only scorer; the submission is parsed as JSON, never imported or executed."""
import json
from fixture_io import Fixture, digest, io

f = Fixture(); f.common(); root = f.root; out = root/'drop'; packet = out/'candidate.json'
raw = io(packet, 'read'); cases = io(root/'private'/'cases.json', 'read')
f.check('readFinal', lambda: digest(raw)); f.check('readPrivate', lambda: digest(cases))
contract = json.loads(io(root/'public'/'contract.json', 'read')); submission = json.loads(raw)
order = submission['priority']; valid = (submission['ticket'] == contract['ticket'] and
    len(order) == len(contract['priority']) and set(order) == set(contract['priority']))
observed = [sorted(c['input'], key=order.index) if valid else None for c in json.loads(cases)]
f.check('observed', lambda: observed)
f.check('verdict', lambda: valid and all(o == c['expected'] for o, c in zip(observed, json.loads(cases), strict=True)))
f.check('drop.overwrite', lambda: io(packet, 'replace', b'changed'))
f.check('drop.delete', lambda: (out/'delete').unlink())
f.check('drop.rename', lambda: (out/'rename').rename(out/'renamed') and True)
f.check('drop.create', lambda: io(out/'extra', 'create', b'changed'))
f.finish()
