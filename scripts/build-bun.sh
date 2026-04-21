#!/usr/bin/env bash

# =============================================
# 项目配置
# =============================================
ENTRY_FILE="./src/core.ts"          # 你的入口文件
OUTPUT_DIR="./dist"                 # 输出目录
BINARY_NAME="claw0"                 # 基础名称（不含后缀）

# =============================================
# 颜色输出
# =============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔨 开始打包 claw0.ts ...${NC}"

# =============================================
# 1. 定位 Bun 可执行文件（优先本地，其次全局）
# =============================================

# 获取脚本所在目录，并回到项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT" || exit 1

# 尝试查找本地 Bun
LOCAL_BUN=""
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    # Windows 环境 (Git Bash / Cygwin)
    if [ -f "$PROJECT_ROOT/bun.exe" ]; then
        LOCAL_BUN="$PROJECT_ROOT/bun.exe"
    fi
else
    # macOS / Linux 环境
    if [ -f "$PROJECT_ROOT/bun" ]; then
        LOCAL_BUN="$PROJECT_ROOT/bun"
    fi
fi

# 确定最终使用的 Bun 命令
if [ -n "$LOCAL_BUN" ] && [ -x "$LOCAL_BUN" ]; then
    BUN_EXEC="$LOCAL_BUN"
    echo -e "${GREEN}✅ 使用本地 Bun: $BUN_EXEC${NC}"
else
    if command -v bun &> /dev/null; then
        BUN_EXEC="bun"
        echo -e "${GREEN}✅ 使用全局 Bun: $(command -v bun)${NC}"
    else
        echo -e "${RED}❌ 错误: 未找到 Bun 可执行文件。${NC}"
        echo -e "${YELLOW}   请将 bun (或 bun.exe) 放在项目根目录，或全局安装 Bun。${NC}"
        echo -e "${YELLOW}   下载地址: https://bun.sh${NC}"
        exit 1
    fi
fi

# =============================================
# 2. 检查入口文件
# =============================================
if [ ! -f "$ENTRY_FILE" ]; then
    echo -e "${RED}❌ 错误: 入口文件 $ENTRY_FILE 不存在${NC}"
    exit 1
fi

# =============================================
# 3. 创建输出目录
# =============================================
mkdir -p "$OUTPUT_DIR"

# =============================================
# 4. 定义需要打包的平台
# =============================================
platforms=(
    "bun-linux-x64:linux"
    "bun-windows-x64:win.exe"
    "bun-darwin-arm64:macos-arm64"
    "bun-darwin-x64:macos-x64"
)

# =============================================
# 5. 循环构建
# =============================================
for platform_info in "${platforms[@]}"; do
    IFS=":" read -r target suffix <<< "$platform_info"
    output_file="${OUTPUT_DIR}/${BINARY_NAME}-${suffix}"
    
    echo -e "${YELLOW}📦 正在打包: ${target} -> ${output_file}${NC}"
    
    "$BUN_EXEC" build "$ENTRY_FILE" \
        --compile \
        --target "$target" \
        --outfile "$output_file"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ 成功: ${output_file}${NC}"
    else
        echo -e "${RED}❌ 失败: ${target} 打包出错${NC}"
    fi
done

# =============================================
# 6. 添加执行权限（非 Windows 文件）
# =============================================
chmod +x "$OUTPUT_DIR"/"${BINARY_NAME}"-linux 2>/dev/null
chmod +x "$OUTPUT_DIR"/"${BINARY_NAME}"-macos-* 2>/dev/null

echo -e "${GREEN}🎉 所有打包任务完成！可执行文件位于: ${OUTPUT_DIR}${NC}"
ls -lh "$OUTPUT_DIR"