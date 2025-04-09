import express from "express";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import axios from "axios";
import fs from "fs";
import path from "path";

const router = express.Router();

// Initialize Octokit with GitHub App authentication
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  userAgent: 'healer-auto-fix-app/1.0.0',
  previews: ['jean-grey-preview', 'symmetra-preview', 'mercy-preview'],
  baseUrl: 'https://api.github.com',
  request: {
    timeout: 60000, // 60 second timeout
    headers: {
      accept: 'application/vnd.github.v3+json',
    }
  },
  log: {
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error
  }
});

// Simple in-memory cache for analysis results
const analysisCache = new Map();

// List of models to try in order
const HUGGINGFACE_MODELS = [
  "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
  "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.1",
  "https://api-inference.huggingface.co/models/facebook/opt-1.3b"
];

// Function to get repository contents recursively
async function getRepoContents(owner, repo, path = "") {
  try {
    console.log(`Fetching contents for ${owner}/${repo} at path: ${path}`);
    const contents = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    // Skip these directories and files
    const skipPatterns = [
      'node_modules',
      'dist',
      'build',
      '.git',
      'coverage',
      'package-lock.json',
      'yarn.lock',
      '.env',
      '.DS_Store'
    ];

    if (Array.isArray(contents.data)) {
      const files = [];
      for (const item of contents.data) {
        try {
          // Skip if the path matches any skip pattern
          if (skipPatterns.some(pattern => item.path.includes(pattern))) {
            console.log(`Skipping ${item.path} (filtered out)`);
            continue;
          }

          if (item.type === "file") {
            console.log(`Processing file: ${item.path}`);
            const content = await getFileContent(owner, repo, item.path);
            if (content) {
              files.push({
                path: item.path,
                content: content,
              });
            }
          } else if (item.type === "dir") {
            console.log(`Processing directory: ${item.path}`);
            const subFiles = await getRepoContents(owner, repo, item.path);
            files.push(...subFiles);
          }
        } catch (itemError) {
          console.error(`Error processing item ${item.path}:`, itemError);
        }
      }
      return files;
    }
    return [];
  } catch (error) {
    console.error(`Error getting contents for ${path}:`, error);
    if (error.response) {
      console.error('Error response:', error.response.data);
    }
    return [];
  }
}

// Get file content from GitHub
async function getFileContent(owner, repo, path) {
  if (!path) {
    console.log('Invalid file path: empty path provided');
    return null;
  }
  
  // Clean the path (remove leading slash, spaces, etc)
  const cleanPath = path.trim().replace(/^\/+/, '');
  
  if (!cleanPath) {
    console.log('Invalid file path after cleaning');
    return null;
  }
  
  console.log(`Fetching content for ${owner}/${repo}/${cleanPath}`);
  
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: cleanPath,
    });
    
    if (response.data.type !== 'file') {
      console.log(`Path ${cleanPath} is not a file`);
      return null;
    }
    
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    console.log(`Successfully fetched content for ${cleanPath} (${content.length} bytes)`);
    return content;
  } catch (error) {
    if (error.status === 404) {
      console.log(`File not found: ${cleanPath}`);
    } else {
      console.error(`Error fetching file ${cleanPath}:`, error.message);
    }
    return null;
  }
}

// Function to make API call with retries and model fallback
async function makeAPICallWithRetry(apiCall, maxRetries = 3) {
  let lastError = null;
  
  for (let modelUrl of HUGGINGFACE_MODELS) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await apiCall(modelUrl);
        
        // Validate response data
        if (!response || !response.data) {
          console.warn(`Empty or invalid response from model ${modelUrl}, attempt ${i + 1}`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        
        // Verify the response format we expect
        if (!Array.isArray(response.data) || !response.data[0] || typeof response.data[0].generated_text !== 'string') {
          console.warn(`Unexpected response format from model ${modelUrl}, attempt ${i + 1}:`, response.data);
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
          continue;
        }
        
        // Valid response
        return response;
      } catch (error) {
        lastError = error;
        console.error(`API call error for model ${modelUrl}, attempt ${i + 1}:`, error.message);
        
        // If rate limited or model is loading, retry
        if (error.response && (error.response.status === 503 || error.response.status === 429) && i < maxRetries - 1) {
          console.log(`Retry attempt ${i + 1} of ${maxRetries} for model ${modelUrl}`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
          continue;
        }
        // If we get here, either we've exhausted retries or got a different error
        break;
      }
    }
  }
  
  // All models failed, construct a fallback response
  console.error("All models failed with error:", lastError?.message || "Unknown error");
  
  // Return a fallback response instead of throwing
  return {
    data: [{
      generated_text: "Sorry, I couldn't analyze this code due to technical limitations. Please try again with a smaller code sample or contact support."
    }]
  };
}

// Function to analyze code using Hugging Face API
async function analyzeCodeWithHuggingFace(code, type) {
  try {
    console.log("Starting Hugging Face analysis...");
    
    // Check cache first
    const cacheKey = `${code.substring(0, 100)}_${type}`;
    if (analysisCache.has(cacheKey)) {
      console.log("Using cached analysis result");
      return analysisCache.get(cacheKey);
    }
    
    // Reduce code size by focusing on key files and truncating content
    const MAX_FILE_SIZE = 2000; // characters per file
    const MAX_FILES = 10; // maximum number of files to analyze
    
    // Split code into files and limit the number of files
    const files = code.split('\n\n').slice(0, MAX_FILES);
    
    // Process each file
    const analysisResults = [];
    try {
      for (const file of files) {
        const [filePath, ...contentLines] = file.split('\n');
        const content = contentLines.join('\n');
        
        // Truncate content if too large
        const truncatedContent = content.length > MAX_FILE_SIZE 
          ? content.substring(0, MAX_FILE_SIZE) + '\n... (truncated)'
          : content;

        const prompt = type === "bugs" 
          ? `You are a code analysis expert. Analyze this code file for potential bugs, issues, and problems. Focus on:
             1. Security vulnerabilities
             2. Performance issues
             3. Code quality problems
             4. Potential runtime errors
             5. Best practice violations
             
             File: ${filePath}
             Code:
             ${truncatedContent}
             
             IMPORTANT INSTRUCTIONS: 
             1. Format each issue EXACTLY as shown below:
             
             Issue: [clear description of the problem]
             Impact: [severity level - high/medium/low]
             Fix: [specific solution to fix the issue]
             
             2. Each issue should be separated by a blank line
             3. Do NOT include code snippets in your response
             4. Do NOT use markdown formatting
             5. Only report ACTUAL issues, not hypothetical ones`
          : `You are a code analysis expert. Suggest improvements for this code file. Focus on:
             1. Code optimization
             2. Modern best practices
             3. Performance enhancements
             4. Security improvements
             5. Maintainability
             
             File: ${filePath}
             Code:
             ${truncatedContent}
             
             IMPORTANT INSTRUCTIONS:
             1. Format each improvement EXACTLY as shown below:
             
             Area: [aspect to improve]
             Suggestion: [specific improvement]
             Benefit: [expected impact]
             
             2. Each improvement should be separated by a blank line
             3. Do NOT include code snippets in your response
             4. Do NOT use markdown formatting
             5. Only suggest REALISTIC improvements, not hypothetical ones`;

        console.log(`Analyzing file: ${filePath}`);
        
        try {
          const response = await makeAPICallWithRetry((modelUrl) => 
            axios.post(
              modelUrl,
              {
                inputs: prompt,
                parameters: {
                  max_new_tokens: 500,
                  temperature: 0.3,
                  top_p: 0.95,
                  return_full_text: false
                }
              },
              {
                headers: {
                  "Authorization": `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                  "Content-Type": "application/json"
                }
              }
            )
          );

          if (response && response.data && response.data[0] && response.data[0].generated_text) {
            analysisResults.push({
              file: filePath,
              analysis: response.data[0].generated_text
            });
          } else {
            analysisResults.push({
              file: filePath,
              analysis: "Failed to analyze this file. The model returned an unexpected response format."
            });
          }
        } catch (fileError) {
          console.error(`Error analyzing file ${filePath}:`, fileError);
          analysisResults.push({
            file: filePath,
            analysis: "Failed to analyze this file due to an error in the AI model."
          });
        }
      }
    } catch (filesError) {
      console.error("Error processing files:", filesError);
    }

    // If no analysis results were generated, provide a default response
    if (analysisResults.length === 0) {
      return {
        issues: [],
        improvements: [],
        status: "error",
        message: "Failed to analyze code. Please try again with a smaller code sample."
      };
    }

    // Combine all analysis results
    const combinedAnalysis = analysisResults
      .map(result => `File: ${result.file}\n${result.analysis}`)
      .join('\n\n');
    
    // Parse the analysis into structured format
    let parsed;
    try {
      parsed = parseAnalysis(combinedAnalysis);
      
      // Add minimal issue/improvement if none were found
      if (parsed.length === 0) {
        console.log("No issues/improvements found, adding a placeholder");
        parsed.push({
          description: type === "bugs" 
            ? "Issue: No specific issues were found\nImpact: low\nFix: No specific fixes needed"
            : "Area: Code review\nSuggestion: No specific improvements needed\nBenefit: Already well implemented",
          priority: "low",
          filePath: "index.js"
        });
      }
    } catch (parseError) {
      console.error("Error parsing analysis:", parseError);
      parsed = [];
    }
    
    const result = {
      issues: type === "bugs" ? parsed : [],
      improvements: type === "features" ? parsed : [],
      status: "success"
    };
    
    // Cache the result
    analysisCache.set(cacheKey, result);
    
    console.log("Parsed analysis result:", result);
    return result;
  } catch (error) {
    console.error("Hugging Face analysis error:", error);
    if (error.response) {
      console.error('Error response:', error.response.data);
      if (error.response.status === 402) {
        throw new Error("API credit limit reached. Please try with a smaller repository or contact support.");
      }
    }
    
    // Return an empty but valid result instead of throwing
    return {
      issues: [],
      improvements: [],
      status: "error",
      message: error.message || "An error occurred during analysis. Please try again."
    };
  }
}

// Function to parse analysis into structured format
function parseAnalysis(analysis) {
  // First split by sections - each proper issue/improvement should have a complete section
  const sections = analysis.split('\n\n').filter(section => section.trim() !== '');
  
  const items = [];
  
  for (const section of sections) {
    // Only consider sections that have the proper format markers
    if (section.includes('Issue:') || 
        section.includes('Impact:') || 
        section.includes('Fix:') ||
        section.includes('Area:') ||
        section.includes('Suggestion:') ||
        section.includes('Benefit:')) {
      
      // Clean the description and extract proper issues
      const cleanedSection = section
        .split('\n')
        .filter(line => {
          // Skip lines that look like code without context
          const trimmedLine = line.trim();
          const isCodeLine = (
            (trimmedLine.includes(';') && !trimmedLine.includes(':')) ||
            (trimmedLine.startsWith('{') || trimmedLine.startsWith('}')) ||
            (trimmedLine.startsWith('const ') || trimmedLine.startsWith('let ') || trimmedLine.startsWith('function ')) ||
            (trimmedLine.startsWith('import ') || trimmedLine.startsWith('export ')) ||
            (trimmedLine.startsWith('<') && trimmedLine.endsWith('>') && !trimmedLine.includes(':'))
          );
          
          return !isCodeLine || trimmedLine.includes('Issue:') || 
                 trimmedLine.includes('Impact:') || trimmedLine.includes('Fix:') || 
                 trimmedLine.includes('Area:') || trimmedLine.includes('Suggestion:') ||
                 trimmedLine.includes('Benefit:');
        })
        .join('\n');
      
      // Extract file path but don't require it
      const filePath = extractFilePath(cleanedSection);
      
      // Add the issue/improvement even if no file path is found
      items.push({
        description: cleanedSection.trim(),
        priority: determinePriority(cleanedSection),
        filePath: filePath || null // Allow null file paths
      });
    }
  }

  return items;
}

// Function to extract file path from issue description
function extractFilePath(description) {
  // First check if we have a File: marker
  const fileMarker = description.match(/File:\s+([\w\-./]+\.\w+)/);
  if (fileMarker && fileMarker[1]) {
    return fileMarker[1].trim();
  }
  
  // Look for specific mentions of filenames with extensions
  const filePattern = /(?:in|from|file|at)\s+([\w\-./]+\.\w+)/i;
  const fileMatch = description.match(filePattern);
  if (fileMatch && fileMatch[1]) {
    return fileMatch[1].trim();
  }
  
  // Try to find any word that looks like a file (has an extension)
  const extensionPattern = /([\w\-./]+\.(js|jsx|ts|tsx|css|html|md|json|py|rb|php|java|go|c|cpp|h|cs))\b/i;
  const extensionMatch = description.match(extensionPattern);
  if (extensionMatch && extensionMatch[1]) {
    return extensionMatch[1].trim();
  }
  
  // Special case for component files based on content
  if (description.toLowerCase().includes("react") && description.toLowerCase().includes("component")) {
    return "src/components/App.jsx"; // Common location for React components
  }
  
  // Fallback to common file types based on content
  if (description.toLowerCase().includes("css") || description.toLowerCase().includes("style")) {
    return "src/styles.css";
  } else if (description.toLowerCase().includes("html")) {
    return "index.html";
  } else if (description.toLowerCase().includes("api") || description.toLowerCase().includes("server")) {
    return "server.js";
  }
  
  // Return null if no file path can be determined
  return null;
}

// Function to determine priority based on keywords
function determinePriority(description) {
  const lowerDescription = description.toLowerCase();
  
  // High priority keywords
  if (lowerDescription.includes("security") || 
      lowerDescription.includes("vulnerability") || 
      lowerDescription.includes("critical") || 
      lowerDescription.includes("error") || 
      lowerDescription.includes("exception") || 
      lowerDescription.includes("crash") || 
      lowerDescription.includes("bug") || 
      lowerDescription.includes("issue") ||
      lowerDescription.includes("high impact") ||
      lowerDescription.includes("severe")) {
    return "high";
  }
  
  // Medium priority keywords
  if (lowerDescription.includes("performance") || 
      lowerDescription.includes("optimize") || 
      lowerDescription.includes("improve") || 
      lowerDescription.includes("enhance") ||
      lowerDescription.includes("medium impact") ||
      lowerDescription.includes("moderate")) {
    return "medium";
  }
  
  return "low";
}

// Update the analyze endpoint to use Hugging Face
router.post("/analyze", async (req, res) => {
  try {
    const { owner, repo, type } = req.body;
    
    console.log("Received analysis request:", { owner, repo, type });
    
    if (!owner || !repo) {
      return res.status(400).json({ 
        error: "Missing required parameters",
        message: "Owner and repository name are required" 
      });
    }

    // Verify repository exists and is accessible
    try {
      await octokit.repos.get({ owner, repo });
    } catch (error) {
      console.error("Repository access error:", error);
      return res.status(404).json({
        error: "Repository not found",
        message: "The specified repository could not be found or accessed"
      });
    }

    console.log(`Starting repository analysis: ${owner}/${repo}`);
    
    // Get repository contents
    console.log("Fetching repository contents...");
    const files = await getRepoContents(owner, repo);
    console.log(`Found ${files.length} files`);
    
    if (files.length === 0) {
      return res.status(400).json({
        error: "No files found",
        message: "No files were found in the repository"
      });
    }

    // Prepare code for analysis with size limit
    const MAX_CODE_SIZE = 10000; // characters
    let codeContent = files
      .filter(file => file.content)
      .map(file => `File: ${file.path}\n${file.content}`)
      .join("\n\n");

    // If content is too large, truncate it
    if (codeContent.length > MAX_CODE_SIZE) {
      console.log(`Code size (${codeContent.length} chars) exceeds limit. Truncating...`);
      codeContent = codeContent.substring(0, MAX_CODE_SIZE) + "\n... (code truncated due to size limit)";
    }

    console.log("Preparing Hugging Face analysis...");
    const analysis = await analyzeCodeWithHuggingFace(codeContent, type);
    console.log("Analysis completed:", analysis);
    
    // Ensure we're sending a valid JSON response
    if (!analysis || (typeof analysis !== 'object')) {
      return res.status(500).json({
        error: "Invalid analysis result",
        message: "The analysis result is empty or invalid",
        status: "error",
        issues: [],
        improvements: []
      });
    }
    
    // Add owner and repo to the response
    const responseData = {
      ...analysis,
      owner,
      repo
    };
    
    res.json(responseData);
  } catch (error) {
    console.error("Analysis error:", error);
    // Ensure we return a valid JSON response even when an error occurs
    let statusCode = 500;
    let errorMessage = "Failed to analyze repository";
    
    if (error.response) {
      console.error('Error response:', error.response.data);
      if (error.response.status === 402) {
        statusCode = 402;
        errorMessage = "The API key has insufficient balance. Please try with a smaller repository or contact support.";
      }
    }
    
    res.status(statusCode).json({ 
      error: "Analysis failed",
      message: error.message || errorMessage,
      status: "error",
      issues: [],
      improvements: []
    });
  }
});

// Get Repository Issues
router.get("/issues/:owner/:repo", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const issues = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "open",
    });
    res.status(200).json(issues.data);
  } catch (error) {
    console.error("Issues fetch error:", error);
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});

// Generate Improvements
router.post("/improve", async (req, res) => {
  try {
    const { owner, repo, type, description } = req.body;
    
    // Create a new branch for improvements
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: "heads/main",
    });

    const newBranchName = `improvements/${Date.now()}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${newBranchName}`,
      sha: baseRef.data.object.sha,
    });

    // Here you would implement the actual improvement logic
    // This could involve:
    // 1. Code analysis
    // 2. Generating improvements
    // 3. Making changes to files
    // 4. Committing changes

    res.status(200).json({
      message: "Improvements generated",
      branch: newBranchName,
    });
  } catch (error) {
    console.error("Improvement error:", error);
    res.status(500).json({ error: "Failed to generate improvements" });
  }
});

// Create Pull Request
router.post("/create-pr", async (req, res) => {
  try {
    const { owner, repo, title, body, head, base } = req.body;
    
    const pr = await octokit.pulls.create({
      owner,
      repo,
      title,
      body,
      head,
      base,
    });

    res.status(200).json(pr.data);
  } catch (error) {
    console.error("PR creation error:", error);
    res.status(500).json({ error: "Failed to create pull request" });
  }
});

// Get Repository Statistics
router.get("/stats/:owner/:repo", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    
    const [contributors, languages, commits] = await Promise.all([
      octokit.repos.listContributors({ owner, repo }),
      octokit.repos.listLanguages({ owner, repo }),
      octokit.repos.listCommits({ owner, repo }),
    ]);

    res.status(200).json({
      contributors: contributors.data,
      languages: languages.data,
      commitCount: commits.data.length,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "Failed to fetch repository statistics" });
  }
});

// Generate a code fix using LLM
async function generateCodeFix(fileContent, issue) {
  try {
    console.log(`Generating fix for issue: "${issue.description.split('\n')[0]}..."`);
    
    // Skip if content or issue is invalid
    if (!fileContent) {
      console.error('Cannot generate fix: file content is empty');
      return null;
    }
    
    if (!issue.description) {
      console.error('Cannot generate fix: issue description is empty');
      return null;
    }
    
    const prompt = `You are an expert code reviewer and fixer.

File content:
\`\`\`
${fileContent}
\`\`\`

Issue to fix:
${issue.description}

Instructions:
1. Analyze the file content and the issue description.
2. Generate the COMPLETE fixed version of the file.
3. Include ALL original code with your fixes applied.
4. DO NOT include any explanations, just the fixed code.

Return the complete fixed file content:`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that fixes code issues.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      const fixedCode = response.data.choices[0].message.content.trim();
      
      // Skip if LLM returned code with markdown backticks
      if (fixedCode.startsWith('```') && fixedCode.endsWith('```')) {
        console.log('Removing markdown code block from LLM response');
        const codeWithoutMarkers = fixedCode
          .replace(/^```[\w]*\n/, '') // Remove opening ```language
          .replace(/```$/, '');        // Remove closing ```
        return codeWithoutMarkers;
      }
      
      console.log(`Successfully generated fix for issue in ${issue.filePath}`);
      return fixedCode;
    } else {
      console.error('Invalid response format from LLM', response.data);
      return null;
    }
  } catch (error) {
    console.error('Error generating code fix:', error.message);
    if (error.response) {
      console.error('LLM API Error:', {
        status: error.response.status,
        data: error.response.data
      });
    }
    return null;
  }
}

// Auto-fix endpoint
router.post("/auto-fix", async (req, res) => {
  const { owner, repo, issues } = req.body;
  let fixes = [];
  let errors = [];
  let prUrl = null;

  try {
    console.log(`Starting auto-fix for ${owner}/${repo} with ${issues?.length || 0} issues`);
    
    if (!issues || issues.length === 0) {
      return res.status(400).json({ error: 'No issues provided' });
    }

    // Filter out issues without a file path
    const validIssues = issues.filter(issue => issue.filePath && issue.filePath.trim() !== '');
    
    if (validIssues.length === 0) {
      return res.status(400).json({ error: 'No valid issues with file paths provided' });
    }
    
    // Get the default branch (usually main or master)
    const repoInfo = await octokit.repos.get({
      owner,
      repo,
    });
    
    const defaultBranch = repoInfo.data.default_branch;
    console.log(`Default branch is: ${defaultBranch}`);
    
    // Get the latest commit SHA on the default branch
    const refData = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    
    const latestCommitSha = refData.data.object.sha;
    console.log(`Latest commit SHA: ${latestCommitSha}`);
    
    // Create a unique branch name
    const timestamp = new Date().getTime();
    const newBranchName = `fix-issues-${timestamp}`;
    console.log(`Creating new branch: ${newBranchName}`);
    
    // Create a new branch
    try {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${newBranchName}`,
        sha: latestCommitSha,
      });
      console.log(`Successfully created branch: ${newBranchName}`);
    } catch (branchError) {
      console.error(`Error creating branch: ${branchError.message}`);
      return res.status(500).json({ 
        error: `Failed to create branch: ${branchError.message}`, 
        fixes, 
        errors: [...errors, `Failed to create branch: ${branchError.message}`] 
      });
    }
    
    let currentTree = latestCommitSha;
    let hasCommits = false;
    
    // Process each issue
    for (const issue of validIssues) {
      try {
        console.log(`Processing issue for file: ${issue.filePath}`);
        
        // Get the file content - first try the direct path
        let fileContent = await getFileContent(owner, repo, issue.filePath);
        
        // If that fails, try some variations (in case the file is in a subdirectory)
        if (!fileContent) {
          console.log(`Could not find file at ${issue.filePath}, trying alternatives...`);
          const alternatives = [
            `src/${issue.filePath}`,
            issue.filePath.replace(/^src\//, ''),
            issue.filePath.startsWith('/') ? issue.filePath.substring(1) : issue.filePath,
            issue.filePath.split('/').pop() // Just the filename
          ];
          
          for (const altPath of alternatives) {
            console.log(`Trying alternative path: ${altPath}`);
            fileContent = await getFileContent(owner, repo, altPath);
            if (fileContent) {
              console.log(`Found file at alternative path: ${altPath}`);
              issue.filePath = altPath; // Update the path
              break;
            }
          }
        }
        
        if (!fileContent) {
          errors.push(`Could not fetch content for file: ${issue.filePath}`);
          continue;
        }

        // Generate the fix
        const fixedCode = await generateCodeFix(fileContent, issue);
        
        if (!fixedCode || fixedCode.trim() === "") {
          errors.push(`Generated empty fix for file: ${issue.filePath}`);
          continue;
        }

        // Create a commit with the fix
        const fileBlob = await octokit.git.createBlob({
          owner,
          repo,
          content: fixedCode,
          encoding: 'utf-8',
        });

        // Create a new tree with the updated file
        const newTree = await octokit.git.createTree({
          owner,
          repo,
          base_tree: currentTree,
          tree: [{
            path: issue.filePath,
            mode: '100644',
            type: 'blob',
            sha: fileBlob.data.sha,
          }],
        });

        // Create a commit
        const commit = await octokit.git.createCommit({
          owner,
          repo,
          message: `Fix: ${issue.description.substring(0, 100)}`,
          tree: newTree.data.sha,
          parents: [currentTree],
        });

        // Update the reference
        await octokit.git.updateRef({
          owner,
          repo,
          ref: `heads/${newBranchName}`,
          sha: commit.data.sha,
        });

        currentTree = commit.data.sha;
        fixes.push({
          file: issue.filePath,
          status: 'success',
          description: issue.description,
        });
        hasCommits = true;
        console.log(`Successfully fixed issue in ${issue.filePath}`);
      } catch (error) {
        console.error(`Error fixing issue in ${issue.filePath}:`, error);
        errors.push(`Failed to fix issue in ${issue.filePath}: ${error.message}`);
      }
    }

    // After processing all issues
    if (hasCommits) {
      try {
        console.log(`Creating pull request from branch: ${newBranchName} to ${defaultBranch}`);
        
        // Check if the branch exists
        try {
          const branchCheck = await octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${newBranchName}`,
          });
          console.log(`Branch ${newBranchName} exists with SHA: ${branchCheck.data.object.sha}`);
        } catch (branchCheckError) {
          console.error(`Error checking branch ${newBranchName}:`, branchCheckError.message);
          throw new Error(`Cannot create PR: Branch ${newBranchName} doesn't exist or is not accessible`);
        }
        
        // Create the PR with more detailed error handling
        console.log(`Creating PR with params: ${owner}/${repo}, head: ${newBranchName}, base: ${defaultBranch}`);
        try {
          const prResponse = await octokit.pulls.create({
            owner,
            repo,
            title: 'Auto-fixes for code issues',
            head: newBranchName,
            base: defaultBranch,
            body: `This PR contains automated fixes for the following issues:
${fixes.map(fix => `- ${fix.description.split('\n')[0]}`).join('\n')}

${errors.length > 0 ? `\nNOTE: Failed to fix ${errors.length} issues:
${errors.map(err => `- ${err}`).join('\n')}` : ''}`,
          });
          
          prUrl = prResponse.data.html_url;
          console.log(`Successfully created pull request: ${prUrl}`);
        } catch (prCreateError) {
          console.error(`Error creating PR:`, prCreateError);
          
          if (prCreateError.message.includes('Not Found')) {
            console.error(`API endpoint not found error. This often means the token lacks permissions.`);
            console.error(`Current scopes: ${await octokit.request('GET /').then(res => res.headers['x-oauth-scopes'] || 'none')}`);
          }
          
          throw prCreateError;
        }
      } catch (prError) {
        console.error(`Error creating pull request: ${prError.message}`);
        errors.push(`Failed to create pull request: ${prError.message}`);
        
        // Return partial success since we did create commits
        return res.status(207).json({
          status: 'partial',
          message: 'Created commits but failed to create pull request',
          branchName: newBranchName,
          fixes,
          errors,
          prUrl: null
        });
      }
    } else {
      console.log('No commits were made, not creating a pull request');
      return res.status(200).json({
        status: 'no-action',
        message: 'No fixes were made',
        fixes,
        errors
      });
    }

    return res.status(200).json({
      status: 'success',
      message: hasCommits ? 'Successfully created fixes and pull request' : 'No fixes were needed',
      branchName: newBranchName,
      fixes,
      errors,
      prUrl
    });
  } catch (error) {
    console.error('Error in auto-fix process:', error);
    return res.status(500).json({
      status: 'error',
      message: `Auto-fix process failed: ${error.message}`,
      errors: [error.message],
      fixes: []
    });
  }
});

export default router;