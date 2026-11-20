"""Independent reader for the second deliverable. Imports no part of a submission."""
import json
from fixture_io import Fixture, digest, io

f = Fixture()
order = io(f.root/'drop'/'order.txt', 'read')
contract = json.loads(io(f.root/'public'/'contract.json', 'read'))
f.check('readExport', lambda: digest(order))
f.check('verdict', lambda: order == ('\n'.join(contract['priority'])+'\n').encode('ascii'))
f.finish()
