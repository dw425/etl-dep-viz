import { DependencyApp } from './components/tiermap/DependencyApp';
import ErrorBoundary from './components/shared/ErrorBoundary';

export default function App() {
  return (
    <ErrorBoundary>
      <DependencyApp />
    </ErrorBoundary>
  );
}
