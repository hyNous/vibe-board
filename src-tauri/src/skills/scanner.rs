use std::fs;
use std::path::{Path, PathBuf};

pub fn read_file_tree(skill_path: &str) -> super::FileTreeNode {
    let path = PathBuf::from(skill_path);
    build_tree(&path)
}

fn build_tree(path: &Path) -> super::FileTreeNode {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if path.is_file() {
        return super::FileTreeNode {
            name,
            node_type: "file".to_string(),
            path: path.display().to_string(),
            children: None,
        };
    }

    let children: Vec<super::FileTreeNode> = fs::read_dir(path)
        .ok()
        .map(|entries| {
            let mut nodes: Vec<_> = entries
                .flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| build_tree(&e.path()))
                .collect();
            nodes.sort_by(|a, b| {
                let a_dir = a.node_type == "dir";
                let b_dir = b.node_type == "dir";
                b_dir.cmp(&a_dir).then(a.name.cmp(&b.name))
            });
            nodes
        })
        .unwrap_or_default();

    super::FileTreeNode {
        name,
        node_type: "dir".to_string(),
        path: path.display().to_string(),
        children: Some(children),
    }
}
