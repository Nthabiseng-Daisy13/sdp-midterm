import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

# Point the API app at a throwaway data directory before it is imported.
import tempfile

_DATA_DIR = os.environ.get("RAT_TEST_DATA_DIR")
if _DATA_DIR is None:
    _DATA_DIR = tempfile.mkdtemp(prefix="rat-test-data-")
    os.environ["RAT_TEST_DATA_DIR"] = _DATA_DIR
os.environ["RAT_DATA_DIR"] = _DATA_DIR
