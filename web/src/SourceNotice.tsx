export function SourceNotice() {
  return (
    <div className="source-notice">
      <a href={`https://github.com/JinsuBae2/saferoute/tree/${__SOURCE_COMMIT__}`} target="_blank" rel="noopener noreferrer">소스 코드</a>
      {" · "}
      <a href={`https://github.com/JinsuBae2/saferoute/blob/${__SOURCE_COMMIT__}/LICENSE`} target="_blank" rel="noopener noreferrer">라이선스 (AGPL-3.0)</a>
    </div>
  );
}
