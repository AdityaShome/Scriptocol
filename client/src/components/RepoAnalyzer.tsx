import { useState } from 'react';
import './RepoAnalyzer.css';

interface AnalysisResult {
  issues: any[];
  improvements: any[];
  status: string;
  message?: string;
}

interface FixResult {
  fixes: any[];
  errors: string[];
  pullRequest: any;
}

export function RepoAnalyzer() {
  const [repoUrl, setRepoUrl] = useState('');
  const [analysisType, setAnalysisType] = useState('bugs'); // 'bugs' or 'features'
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fixing, setFixing] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: string } | null>(null);

  const handleAnalyze = async () => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setFixResult(null);
      setMessage({ text: "Starting analysis...", type: "info" });
      
      // Extract owner and repo from URL
      const urlParts = repoUrl.split('/');
      const owner = urlParts[urlParts.length - 2];
      const repo = urlParts[urlParts.length - 1];

      if (!owner || !repo) {
        throw new Error('Invalid repository URL. Please use the format: https://github.com/owner/repo');
      }

      console.log('Analyzing repository:', { owner, repo, type: analysisType });
      setMessage({ text: `Analyzing ${owner}/${repo}...`, type: "info" });

      try {
        // Call the analysis endpoint
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner,
            repo,
            type: analysisType,
          }),
        });

        console.log('Response status:', response.status);
        
        // Check if response is ok before parsing JSON
        if (!response.ok) {
          if (response.status === 204) {
            throw new Error('Server returned empty response');
          }
          
          let errorData = { message: 'Server error: ' + response.status };
          try {
            errorData = await response.json();
          } catch (jsonError) {
            console.error('Failed to parse error response:', jsonError);
          }
          
          throw new Error(errorData.message || `Analysis failed with status: ${response.status}`);
        }

        // Check if response has content before parsing
        if (response.headers.get('Content-Length') === '0') {
          throw new Error('Server returned empty response');
        }

        let data;
        try {
          data = await response.json();
          console.log('Server response:', data);
        } catch (jsonError) {
          console.error('JSON parse error:', jsonError);
          throw new Error('Failed to parse server response. The server may be experiencing issues.');
        }

        if (!data || (!data.issues && !data.improvements)) {
          throw new Error('Invalid response format from server');
        }

        // Add owner and repo to data
        data.owner = owner;
        data.repo = repo;
        
        setResult(data);
        setMessage({ text: "Analysis completed successfully!", type: "success" });
      } catch (fetchError) {
        console.error('Fetch error:', fetchError);
        setMessage({ text: `Connection error: ${fetchError.message}`, type: "error" });
        throw new Error(`Server connection error: ${fetchError.message}. Please make sure the server is running.`);
      }
    } catch (err) {
      console.error('Analysis error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleAutoFix = async () => {
    if (!result || !result.issues || result.issues.length === 0) {
      setError('No issues found to fix. Please analyze the repository first.');
      return;
    }

    try {
      setFixing(true);
      setError(null);
      setFixResult(null);

      // Extract owner and repo from URL
      const urlParts = repoUrl.split('/');
      const owner = urlParts[urlParts.length - 2];
      const repo = urlParts[urlParts.length - 1];

      if (!owner || !repo) {
        throw new Error('Invalid repository URL. Please use the format: https://github.com/owner/repo');
      }

      console.log('Sending auto-fix request:', { owner, repo, issuesCount: result.issues.length });

      // Call the auto-fix endpoint
      const response = await fetch('/api/auto-fix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          owner,
          repo,
          issues: result.issues,
        }),
      });

      // Try to parse the response even if not OK
      let data;
      try {
        data = await response.json();
        console.log('Auto-fix response:', data);
      } catch (jsonError) {
        console.error('Failed to parse auto-fix response:', jsonError);
        throw new Error('Server returned an invalid response. This could be due to a server error or timeout.');
      }

      // Check for errors in response
      if (!response.ok) {
        const errorMessage = data.message || `Auto-fix failed with status: ${response.status}`;
        throw new Error(errorMessage);
      }

      // Even if the response is OK, check for error status
      if (data.status === 'error') {
        throw new Error(data.message || 'Auto-fix operation encountered errors');
      }

      // If we have partial success (fixes applied but PR failed), show a warning
      if (data.status === 'partial') {
        setError(`Warning: ${data.message}`);
      }

      // Set fix result
      setFixResult({
        fixes: data.fixes || [],
        errors: data.errors || [],
        pullRequest: data.pullRequest
      });
    } catch (err) {
      console.error('Auto-fix error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred during auto-fix');
      // Clear partial results
      setFixResult(null);
    } finally {
      setFixing(false);
    }
  };

  const handleApplyFixes = async () => {
    if (!result || !result.issues || result.issues.length === 0) {
      setMessage({ text: "No issues to fix", type: "error" });
      return;
    }

    try {
      setLoading(true);
      setMessage({ text: "Applying fixes...", type: "info" });

      const response = await fetch("/api/auto-fix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner: result.owner,
          repo: result.repo,
          issues: result.issues
        }),
      });

      const resultData = await response.json();
      
      if (response.ok) {
        if (resultData.status === 'success' && resultData.prUrl) {
          setMessage({ 
            text: `Successfully created fixes and pull request! ${resultData.fixes.length} issues fixed.`, 
            type: "success" 
          });
          // Open the PR URL in a new tab
          window.open(resultData.prUrl, '_blank');
        } else if (resultData.status === 'partial') {
          setMessage({ 
            text: `Created fixes but couldn't create pull request. Branch name: ${resultData.branchName}`, 
            type: "warning" 
          });
        } else if (resultData.status === 'no-action') {
          setMessage({ 
            text: "No changes were made. Please check the issues descriptions.", 
            type: "warning" 
          });
        } else {
          setMessage({ 
            text: resultData.message || "Fix process completed with unknown status", 
            type: "info" 
          });
        }
      } else {
        setMessage({ 
          text: `Error: ${resultData.error || resultData.message || "Unknown error"}`, 
          type: "error" 
        });
        console.error("Fix error details:", resultData);
      }
    } catch (error) {
      console.error("Fix application error:", error);
      setMessage({ 
        text: `Failed to apply fixes: ${error instanceof Error ? error.message : "Unknown error"}`, 
        type: "error" 
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="repo-analyzer">
      <h2>Repository Analyzer</h2>
      
      <div className="input-group">
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="Enter GitHub repository URL (e.g., https://github.com/owner/repo)"
          className="repo-input"
        />
        
        <select
          value={analysisType}
          onChange={(e) => setAnalysisType(e.target.value)}
          className="analysis-select"
        >
          <option value="bugs">Find Bugs</option>
          <option value="features">Suggest Features</option>
        </select>

        <button
          onClick={handleAnalyze}
          disabled={loading || !repoUrl}
          className="analyze-button"
        >
          {loading ? 'Analyzing...' : 'Analyze Repository'}
        </button>
      </div>

      {error && (
        <div className="error-message">
          <h4>Error</h4>
          <p>{error}</p>
          <p className="error-help">
            Please check:
            <ul>
              <li>The repository URL is correct</li>
              <li>The repository is public or you have access</li>
              <li>The server is running</li>
            </ul>
          </p>
        </div>
      )}

      {result && (
        <div className="results">
          <h3>Analysis Results</h3>
          
          {result.status === "error" && (
            <div className="error-message">
              <p>{result.message || "An error occurred during analysis."}</p>
              <p>Please try again or try with a smaller repository.</p>
            </div>
          )}
          
          {result.issues && result.issues.length > 0 && (
            <div className="issues-container">
              <h3>Issues Found</h3>
              <div className="issues-list">
                {result.issues.map((issue, index) => (
                  <div key={index} className="issue-item">
                    <div className="issue-content">
                      <div className="issue-title">
                        {issue.description.split('\n')[0].replace('Issue:', '').trim()}
                      </div>
                      {issue.description.split('\n').map((line, i) => {
                        if (i === 0 || line.trim() === '') return null;
                        
                        if (line.includes('Impact:')) {
                          return <div key={i} className="issue-impact"><strong>Impact:</strong> {line.split('Impact:')[1].trim()}</div>;
                        } else if (line.includes('Fix:')) {
                          return <div key={i} className="issue-fix"><strong>Fix:</strong> {line.split('Fix:')[1].trim()}</div>;
                        } else if (i > 0) {
                          return <div key={i} className="issue-line">{line}</div>;
                        }
                        return null;
                      })}
                      {issue.filePath && (
                        <div className="issue-file"><strong>File:</strong> {issue.filePath}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <button 
                className="apply-fixes-button" 
                onClick={handleApplyFixes}
                disabled={loading}
              >
                {loading ? 'Applying Fixes...' : 'Apply Fixes'}
              </button>
            </div>
          )}

          {result.issues && result.issues.length === 0 && result.status !== "error" && analysisType === 'bugs' && (
            <div className="success-message">
              <p>No issues were found in this repository. Great job!</p>
            </div>
          )}

          {result.improvements && result.improvements.length > 0 && (
            <div className="improvements-section">
              <h4>Suggested Improvements</h4>
              <ul>
                {result.improvements.map((improvement, index) => (
                  <li key={index}>
                    <div className="improvement-item">
                      <div className="improvement-content">
                        {improvement.description.split('\n').map((line, i) => {
                          if (line.trim() === '') return null;
                          
                          if (line.includes('Area:')) {
                            return <div key={i} className="improvement-area"><strong>{line.split('Area:')[0]}Area:</strong> {line.split('Area:')[1]}</div>;
                          } else if (line.includes('Suggestion:')) {
                            return <div key={i} className="improvement-suggestion"><strong>{line.split('Suggestion:')[0]}Suggestion:</strong> {line.split('Suggestion:')[1]}</div>;
                          } else if (line.includes('Benefit:')) {
                            return <div key={i} className="improvement-benefit"><strong>{line.split('Benefit:')[0]}Benefit:</strong> {line.split('Benefit:')[1]}</div>;
                          } else {
                            return <div key={i} className="improvement-line">{line}</div>;
                          }
                        })}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          {result.improvements && result.improvements.length === 0 && result.status !== "error" && analysisType === 'features' && (
            <div className="success-message">
              <p>No improvement suggestions were found. Your code looks great!</p>
            </div>
          )}
        </div>
      )}

      {fixResult && (
        <div className="fix-results">
          <h3>Auto-Fix Results</h3>
          
          {fixResult.fixes && fixResult.fixes.length > 0 ? (
            <div className="fixes-section">
              <h4>Successful Fixes ({fixResult.fixes.length})</h4>
              <ul>
                {fixResult.fixes.map((fix, index) => (
                  <li key={index}>
                    <div className="fix-item">
                      <span className="fix-file">
                        <strong>File:</strong> {fix.file}
                      </span>
                      <span className="fix-description">
                        <strong>Issue:</strong> {fix.description?.substring(0, 100)}...
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="no-fixes-message">
              <p>No fixes were successfully applied.</p>
            </div>
          )}

          {fixResult.errors && fixResult.errors.length > 0 && (
            <div className="fix-errors">
              <h4>Errors During Fix ({fixResult.errors.length})</h4>
              <ul>
                {fixResult.errors.map((error, index) => (
                  <li key={index} className="error-item">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {fixResult.pullRequest && (
            <div className="pull-request">
              <h4>Pull Request Created</h4>
              <div className="pr-details">
                <p>
                  <strong>Title:</strong> {fixResult.pullRequest.title}
                </p>
                <p>
                  <strong>Branch:</strong> {fixResult.pullRequest.head.ref} → {fixResult.pullRequest.base.ref}
                </p>
                <p>
                  <a 
                    href={fixResult.pullRequest.html_url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="pr-link"
                  >
                    View Pull Request on GitHub
                  </a>
                </p>
              </div>
            </div>
          )}

          {!fixResult.pullRequest && fixResult.fixes && fixResult.fixes.length > 0 && (
            <div className="pr-error">
              <p>
                <strong>Note:</strong> Fixes were applied but no pull request was created. 
                The changes are still saved to a new branch.
              </p>
            </div>
          )}
        </div>
      )}

      {message && (
        <div className={`message-${message.type}`}>
          {message.text}
        </div>
      )}
    </div>
  );
} 