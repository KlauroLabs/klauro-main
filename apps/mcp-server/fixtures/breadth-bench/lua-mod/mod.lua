local M = {}
function M.save(x)
  return store(x)
end
local function helper(a) return a+1 end
local json = require("json")
M.save(helper(5))
return M
