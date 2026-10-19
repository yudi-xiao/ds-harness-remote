import { HistoryOutlined, LinkOutlined, MobileOutlined } from '@ant-design/icons'

export function SiteFooter() {
  return <footer className="site-footer app-footer">
    <span>DSH Remote</span>
    <div className="site-footer-links">
      <a href="/" className="site-footer-link" aria-label="返回首页"><LinkOutlined aria-hidden="true" /><span>返回首页</span></a>
      <a href="/changelog" className="site-footer-link" aria-label="更新日志"><HistoryOutlined aria-hidden="true" /><span>更新日志</span></a>
      <a href="/download" className="site-footer-link" aria-label="移动端"><MobileOutlined aria-hidden="true" /><span>移动端</span></a>
    </div>
  </footer>
}
