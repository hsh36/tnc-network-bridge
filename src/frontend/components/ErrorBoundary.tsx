import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/Button';
import { Card, CardBody } from './ui/Card';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | undefined;
}

/** Catches render-time crashes in any page so one broken panel never blanks the whole app (T33). */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unhandled error in UI', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) {
      return this.props.children;
    }
    return (
      <div className="p-6">
        <Card>
          <CardBody className="flex flex-col items-start gap-3">
            <p className="text-sm font-semibold text-status-error">Something went wrong</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{this.state.error.message}</p>
            <Button size="sm" onClick={() => this.setState({ error: undefined })}>
              Try again
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }
}
