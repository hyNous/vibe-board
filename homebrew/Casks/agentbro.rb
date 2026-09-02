cask "agentbro" do
  version "0.1.4"
  sha256 :no_check

  url "https://github.com/shirenchuang/agentbro/releases/download/v#{version}/Agent Island_#{version}_universal.dmg"
  name "Agent Island"
  desc "Menu bar companion for Claude Code, Codex, Gemini CLI and more"
  homepage "https://www.agentbro.net"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :sonoma"

  app "Agent Island.app"

  zap trash: [
    "~/.agentbro",
    "~/Library/Application Support/com.agentbro.desktop",
    "~/Library/Preferences/com.agentbro.desktop.plist",
  ]
end
