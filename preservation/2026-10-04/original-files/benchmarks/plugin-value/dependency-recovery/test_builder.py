import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-overlay.py")
SPEC = importlib.util.spec_from_file_location("dependency_overlay_builder", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuilderContractTests(unittest.TestCase):
    def test_site_root_and_file_paths_are_normalized(self):
        self.assertEqual(MODULE.safe_path("/usr/local/lib/python3.12/site-packages"), MODULE.SITE_ROOT)
        self.assertEqual(MODULE.safe_path("/usr/local/lib/python3.12/site-packages/a.py"), f"{MODULE.SITE_ROOT}/a.py")
        with self.assertRaises(ValueError):
            MODULE.safe_path("/usr/local/lib/python3.12/site-packages/../secret")
        with self.assertRaises(ValueError):
            MODULE.safe_path("/app/secret")

    def test_overlay_members_are_exactly_the_repair_set(self):
        info = {"path": f"{MODULE.SITE_ROOT}/pkg", "type": "directory", "mode": 0o755, "uid": 0, "gid": 0}
        file_info = {"path": f"{MODULE.SITE_ROOT}/pkg/a.py", "type": "regular", "mode": 0o644, "uid": 0, "gid": 0, "size": 1, "sha256": "a" * 64}
        with tempfile.NamedTemporaryFile(suffix=".tar") as temporary:
            with tarfile.open(temporary.name, mode="w") as archive:
                directory = tarfile.TarInfo(info["path"])
                directory.type = tarfile.DIRTYPE
                directory.mode = info["mode"]
                archive.addfile(directory)
                file_entry = tarfile.TarInfo(file_info["path"])
                file_entry.mode = file_info["mode"]
                file_entry.size = 1
                archive.addfile(file_entry, io.BytesIO(b"a"))
            MODULE.verify_overlay_tar(temporary.name, {info["path"]: info, file_info["path"]: file_info})

    def test_config_projection_excludes_build_history(self):
        image = {"Config": {"Env": ["A=B"], "Cmd": ["python"], "Labels": {"x": "y"}, "User": "0", "Created": "volatile"}}
        projection = MODULE.config_projection(image)
        self.assertEqual(projection["Env"], ["A=B"])
        self.assertNotIn("Created", projection)


if __name__ == "__main__":
    unittest.main()
