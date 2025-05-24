# Scriptocol

An AI-powered GitHub repository analyzer that automatically detects bugs and suggests improvements using Hugging Face's AI models.

## Features

- **Automated Code Analysis**: Scans GitHub repositories for bugs and potential improvements
- **AI-Powered Suggestions**: Uses Hugging Face models to generate intelligent code recommendations
- **Automated Fixes**: Can automatically create pull requests with suggested fixes
- **Multi-Language Support**: Works with JavaScript, Python, and Go repositories
- **Priority-based Issues**: Categorizes issues by severity (high, medium, low)
![Screenshot 2025-04-09 045526](https://github.com/user-attachments/assets/d6ba7cbb-45e5-4ab5-b738-272533d38863)

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express
- **AI Integration**: Hugging Face API
- **GitHub Integration**: Probot
- **Styling**: Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm or yarn
- GitHub account
- Hugging Face API token

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/Scriptocol.git
cd Scriptocol
```

2. Install dependencies:
```bash
npm run install-all
```

3. Set up environment variables:
```bash
cp .env.example .env
```
Edit `.env` and add your:
- GitHub Token
- Hugging Face Token
- Webhook Secret

4. Start the development server:
```bash
npm run dev
```

## Usage

1. Open the web interface at `http://localhost:5173`
2. Enter a GitHub repository URL
3. Choose analysis type (bugs or improvements)
4. View results and apply suggested fixes

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Hugging Face for AI models
- GitHub for repository access
- The open-source community
