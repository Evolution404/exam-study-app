import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Download, RefreshCw, ShieldCheck } from "lucide-react";

type RecoveryScreenProps = {
  error?: unknown;
  onRetry: () => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : "应用初始化失败";
}

/**
 * Rendered outside AppShell so a failed IndexedDB migration still leaves the
 * user with a safe recovery path. None of the actions here mutate local data.
 */
export function AppRecoveryScreen({ error, onRetry }: RecoveryScreenProps) {
  const hasError = error !== undefined && error !== null;
  return <main className="app-shell" role="alert" data-testid="app-recovery-screen">
    <div className="content">
      <section className="bank-empty-state">
        <span className="bank-empty-icon" aria-hidden="true"><AlertTriangle size={27} /></span>
        <div>
          <p className="eyebrow">本地数据仍在设备上</p>
          <h1>应用暂时无法加载</h1>
          <p>启动或数据库迁移遇到问题。应用不会因为这个错误自动删除题库、作答记录或同步配置；请先重试，并保留当前页面数据。</p>
          <p><strong>如果重试后仍失败：</strong>关闭本站的其他标签页后再次重试；成功进入应用后，先在“题库”导出 JSON/Excel 备份，再按需前往“同步”页清除本机数据。清除前请确认已经导出或完成远端同步，远端私有仓库不会因本机清除而删除。</p>
          {hasError && <details><summary>查看启动错误信息</summary><code>{errorMessage(error)}</code></details>}
        </div>
        <div className="bank-empty-actions">
          <button className="primary" onClick={onRetry}><RefreshCw size={17} />重试加载</button>
          <span className="section-kicker"><ShieldCheck size={14} />不会自动清除数据</span>
          <span className="section-kicker"><Download size={14} />进入后先导出备份</span>
        </div>
      </section>
    </div>
  </main>;
}

type Props = { children: ReactNode };
type State = { error: unknown };

/** Catch render/lazy-component failures without hiding the local-first data. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep diagnostics local to the browser console; never send the token or
    // database contents to a third-party telemetry endpoint from this screen.
    console.error("应用渲染失败", error, info.componentStack);
  }

  retry = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    if (this.state.error) return <AppRecoveryScreen error={this.state.error} onRetry={this.retry} />;
    return this.props.children;
  }
}
