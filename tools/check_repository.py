"""CI checks for the repository's documented collaboration rules."""

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit


TYPES = "feat|fix|docs|refactor|test|chore"
BRANCH = re.compile(rf"({TYPES})/([1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*")
SUBJECT = re.compile(rf"({TYPES})\(([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\): \S.* \(#([1-9][0-9]*)\)")
FENCES = re.compile(r"^```([^\n]*)\n(.*?)^```\s*$", re.M | re.S)
SECTIONS = ("연결 이슈", "변경 내용", "확인 방법 및 결과", "남은 작업·주의 사항", "머지 전 확인")


def check_pr(pr, commits):
    errors = []
    title = SUBJECT.fullmatch(pr["title"])
    if not title:
        return ["PR 제목: <type>(<scope>): <변경 내용> (#이슈번호) 형식을 사용하세요."]
    kind, scope, issue = title.groups()
    release = pr["head"]["ref"] == "develop" and pr["base"]["ref"] == "main"
    if release:
        if (kind, scope) != ("chore", "release"):
            errors.append("develop → main 배포 PR은 chore(release) 형식을 사용하세요.")
    else:
        branch = BRANCH.fullmatch(pr["head"]["ref"])
        if not branch:
            return ["브랜치: <type>/<이슈번호>-<kebab-case> 형식을 사용하세요."]
        if pr["base"]["ref"] != "develop":
            errors.append("작업 PR은 develop을 대상으로 해야 합니다.")
        if (kind, issue) != branch.groups():
            errors.append("PR 제목의 type·이슈 번호를 브랜치와 맞추세요.")
    body = pr.get("body") or ""
    if not re.search(rf"^Closes #{issue}\s*$", body, re.M):
        errors.append(f"PR 본문에 Closes #{issue}를 작성하세요.")
    for section in SECTIONS:
        if not re.search(rf"^## {re.escape(section)}\s*$", body, re.M):
            errors.append(f"PR 템플릿 항목이 없습니다: {section}")
    skip = re.compile(r"\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true", re.I)
    for message in [pr["title"], *commits]:
        if skip.search(message):
            errors.append("CI 생략 문구를 사용할 수 없습니다.")
    for message in commits:
        subject = SUBJECT.fullmatch(message)
        if not subject or (not release and subject.group(3) != issue):
            errors.append(f"커밋 양식·이슈 번호를 확인하세요: {message}")
    return errors


def anchor(title):
    return re.sub(r"[^\w -]", "", title.lower()).replace(" ", "-")


def check_documents(root, paths):
    root = root.resolve()
    documents = {
        (root / path).resolve(): (root / path).read_text(encoding="utf-8")
        for path in paths if path.suffix == ".md"
    }
    plain = {path: FENCES.sub("", content) for path, content in documents.items()}
    anchors = {
        path: {anchor(h) for h in re.findall(r"^#{1,6} (.+)$", content, re.M)}
        for path, content in plain.items()
    }
    errors = []
    for path, content in documents.items():
        name = path.relative_to(root)
        if content.count("```") % 2:
            errors.append(f"{name}: 닫히지 않은 코드 블록")
        for language, code in FENCES.findall(content):
            if language == "json":
                try:
                    json.loads(code)
                except ValueError:
                    errors.append(f"{name}: 잘못된 JSON 예제")
        for target in re.findall(r"(?<!!)\[[^\]]+\]\(([^)]+)\)", plain[path]):
            url = urlsplit(target)
            if url.scheme or url.netloc:
                continue
            destination = (path.parent / unquote(url.path)).resolve() if url.path else path
            if not destination.is_relative_to(root) or not destination.exists():
                errors.append(f"{name}: 없는 로컬 링크 {target}")
            elif url.fragment and destination in anchors:
                if unquote(url.fragment) not in anchors[destination]:
                    errors.append(f"{name}: 없는 제목 링크 {target}")
    return errors


def main():
    root = Path(__file__).resolve().parents[1]
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=root, encoding="utf-8")
    paths = [Path(name) for name in tracked.split("\0") if name]
    errors = check_documents(root, paths)
    for path in paths:
        if path.suffix in {".pem", ".key"} or (path.name.startswith(".env") and path.name != ".env.example"):
            errors.append(f"저장소에 포함할 수 없는 비밀 설정 파일: {path}")
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        pr = event["pull_request"]
        revision = f'{pr["base"]["sha"]}..{pr["head"]["sha"]}'
        commits = subprocess.check_output(
            ["git", "log", "--no-merges", "--format=%s", revision], cwd=root, encoding="utf-8"
        ).splitlines()
        errors.extend(check_pr(pr, commits))
    for error in errors:
        print(error)
    if not errors:
        print(f"Repository checks passed ({len(paths)} tracked files).")
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
