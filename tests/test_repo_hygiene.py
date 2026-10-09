"""Guard: nothing secret or personal may be tracked by git. Run:  python3 -m unittest tests.test_repo_hygiene -v"""
import pathlib, re, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent

class RepoHygiene(unittest.TestCase):
    def tracked(self): return subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    def test_no_secrets_logs_or_user_data_are_tracked(self):
        bad = [f for f in self.tracked() if re.search(r"(\.session_secret|auth\.json|\.log$|\.lock$|^docs/|^data/(?!sample/|users\.example\.json))", f)]
        self.assertEqual(bad, [], f"must not be committed: {bad}")
    def test_no_credential_looking_values_in_tracked_code(self):
        for f in self.tracked():
            if not f.endswith((".py", ".js", ".html", ".css", ".md")): continue
            txt = (ROOT / f).read_text(errors="ignore")
            self.assertIsNone(re.search(r"\b[0-9a-f]{64}\b", txt), f"{f}: contains a 64-hex string that looks like a key")
            self.assertIsNone(re.search(r"(?i)(api[_-]?key|secret|token)\s*[:=]\s*['\"][A-Za-z0-9+/_-]{16,}", txt), f"{f}: looks like a hardcoded credential")
if __name__ == "__main__": unittest.main()
