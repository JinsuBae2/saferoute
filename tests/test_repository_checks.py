import tempfile
import unittest
from pathlib import Path

from tools.check_repository import check_documents, check_pr


def pull_request(branch="feat/12-fire-events", title="feat: 감지 이벤트 추가 (#12)"):
    return {
        "head": {"ref": branch},
        "base": {"ref": "main"},
        "title": title,
        "body": (
            "## 연결 이슈\nCloses #12\n\n"
            "## 변경 내용\n이벤트 입력을 추가했습니다.\n\n"
            "## 확인 방법 및 결과\n정상 입력·잘못된 ID 검사를 통과했습니다.\n\n"
            "## 남은 작업·주의 사항\n없음\n\n"
            "## 머지 전 확인\n- [x] 확인했습니다.\n"
        ),
    }


class ConventionTests(unittest.TestCase):
    def test_valid_workflow_without_review_requirement(self):
        self.assertEqual(check_pr(pull_request(), ["feat: 감지 이벤트 추가 (#12)"]), [])

    def test_rejects_branch_without_issue(self):
        self.assertTrue(check_pr(pull_request(branch="feat/fire-events"), []))

    def test_rejects_title_for_another_issue(self):
        self.assertTrue(check_pr(pull_request(title="feat: 감지 이벤트 추가 (#13)"), []))

    def test_rejects_unlinked_issue(self):
        pr = pull_request()
        pr["body"] = pr["body"].replace("Closes #12", "관련 #12")
        self.assertTrue(check_pr(pr, []))

    def test_rejects_missing_template_section(self):
        pr = pull_request()
        pr["body"] = pr["body"].replace("## 확인 방법 및 결과", "## 결과")
        self.assertTrue(check_pr(pr, []))

    def test_rejects_commit_with_wrong_issue_or_skip_marker(self):
        for message in ["fix: 입력 보완 (#13)", "feat: [skip ci] 입력 추가 (#12)", "작업 중"]:
            with self.subTest(message=message):
                self.assertTrue(check_pr(pull_request(), [message]))


class DocumentTests(unittest.TestCase):
    def test_valid_korean_anchor_and_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("[문서](guide.md#1-설정-확인)\n")
            (root / "guide.md").write_text('# 1. 설정 확인\n\n```json\n{"version": 1}\n```\n')
            self.assertEqual(check_documents(root, [Path("README.md"), Path("guide.md")]), [])

    def test_rejects_missing_file_and_anchor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("# 안내\n\n[없음](missing.md)\n[절](#없는-절)\n")
            self.assertEqual(len(check_documents(root, [Path("README.md")])), 2)

    def test_rejects_invalid_json_and_unclosed_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for content in ['```json\n{broken}\n```\n', '```text\nnever closed\n']:
                (root / "README.md").write_text(content)
                self.assertTrue(check_documents(root, [Path("README.md")]))


if __name__ == "__main__":
    unittest.main()
