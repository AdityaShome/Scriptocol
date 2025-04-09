import { RepoAnalyzer } from './components/RepoAnalyzer'
import './App.css'

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>GitHub Repository Analyzer</h1>
        <p>Analyze repositories for bugs and suggest improvements</p>
      </header>
      <main>
        <RepoAnalyzer />
      </main>
    </div>
  )
}

export default App
