import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  HttpStatus,
  BadRequestException,
  NotFoundException
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { FunctionCallService } from '../services/function-call.service';
import { CallChain } from '../../database/entities/call-chain.entity';
import { FunctionCall } from '../../database/entities/function-call.entity';

@ApiTags('Function Calls')
@Controller('api/v1/function-calls')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FunctionCallController {
  constructor(private readonly functionCallService: FunctionCallService) {}

  @Get('chains/component/:componentId')
  @ApiOperation({
    summary: 'Get all call chains for a component',
    description: 'Returns all function call chains that include the specified component'
  })
  @ApiParam({ name: 'componentId', description: 'Component ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Call chains retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          chainType: { type: 'string', enum: ['entry-to-exit', 'circular', 'recursive', 'dead-end', 'hot-path', 'critical-path'] },
          entryFunction: { type: 'string' },
          exitFunction: { type: 'string' },
          path: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                componentName: { type: 'string' },
                functionName: { type: 'string' },
                line: { type: 'number' },
                callType: { type: 'string' },
                depth: { type: 'number' }
              }
            }
          },
          length: { type: 'number' },
          complexity: { type: 'number' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          isHotPath: { type: 'boolean' },
          isCritical: { type: 'boolean' }
        }
      }
    }
  })
  async getCallChainsForComponent(
    @Param('componentId') componentId: string
  ): Promise<CallChain[]> {
    if (!componentId) {
      throw new BadRequestException('Component ID is required');
    }
    return this.functionCallService.getCallChainsForComponent(componentId);
  }

  @Get('function/:componentId/:functionName')
  @ApiOperation({
    summary: 'Get function call relationships',
    description: 'Returns all functions that call this function (callers) and all functions this function calls (callees)'
  })
  @ApiParam({ name: 'componentId', description: 'Component ID' })
  @ApiParam({ name: 'functionName', description: 'Function name' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Function calls retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        callers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              callerComponent: { type: 'string' },
              callerFunction: { type: 'string' },
              line: { type: 'number' },
              callType: { type: 'string' },
              isAsync: { type: 'boolean' },
              isConditional: { type: 'boolean' },
              isInLoop: { type: 'boolean' }
            }
          }
        },
        callees: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              targetFunction: { type: 'string' },
              targetComponent: { type: 'string' },
              line: { type: 'number' },
              callType: { type: 'string' },
              argumentCount: { type: 'number' }
            }
          }
        }
      }
    }
  })
  async getFunctionCalls(
    @Param('componentId') componentId: string,
    @Param('functionName') functionName: string
  ): Promise<{ callers: FunctionCall[]; callees: FunctionCall[] }> {
    if (!componentId || !functionName) {
      throw new BadRequestException('Component ID and function name are required');
    }
    return this.functionCallService.getFunctionCallsForFunction(componentId, functionName);
  }

  @Get('hot-paths/:analysisRunId')
  @ApiOperation({
    summary: 'Get hot paths',
    description: 'Returns frequently executed function call chains'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Hot paths retrieved successfully'
  })
  async getHotPaths(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<CallChain[]> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getHotPaths(analysisRunId);
  }

  @Get('critical-paths/:analysisRunId')
  @ApiOperation({
    summary: 'Get critical paths',
    description: 'Returns function call chains identified as critical for performance or reliability'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Critical paths retrieved successfully'
  })
  async getCriticalPaths(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<CallChain[]> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getCriticalPaths(analysisRunId);
  }

  @Get('chain/:chainId')
  @ApiOperation({
    summary: 'Get specific call chain details',
    description: 'Returns detailed information about a specific function call chain'
  })
  @ApiParam({ name: 'chainId', description: 'Call chain ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Call chain details retrieved successfully'
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Call chain not found'
  })
  async getCallChainDetails(
    @Param('chainId') chainId: string
  ): Promise<CallChain> {
    const chain = await this.functionCallService.getCallChainById(chainId);
    if (!chain) {
      throw new NotFoundException(`Call chain with ID ${chainId} not found`);
    }
    return chain;
  }

  @Get('stats/:analysisRunId')
  @ApiOperation({
    summary: 'Get call chain statistics',
    description: 'Returns statistics about function calls and chains for an analysis run'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Statistics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        totalFunctionCalls: { type: 'number' },
        totalCallChains: { type: 'number' },
        uniqueFunctions: { type: 'number' },
        averageChainLength: { type: 'number' },
        maxChainDepth: { type: 'number' },
        circularDependencies: { type: 'number' },
        hotPaths: { type: 'number' },
        criticalPaths: { type: 'number' },
        externalCalls: { type: 'number' },
        asyncCalls: { type: 'number' },
        recursiveCalls: { type: 'number' },
        topCalledFunctions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              function: { type: 'string' },
              callCount: { type: 'number' }
            }
          }
        },
        topCallingFunctions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              function: { type: 'string' },
              callCount: { type: 'number' }
            }
          }
        }
      }
    }
  })
  async getCallStatistics(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<any> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getCallStatistics(analysisRunId);
  }

  @Get('graph/:analysisRunId')
  @ApiOperation({
    summary: 'Get complete call graph',
    description: 'Returns the complete function call graph for visualization'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiQuery({ name: 'depth', required: false, description: 'Maximum depth to traverse', type: 'number' })
  @ApiQuery({ name: 'includeExternal', required: false, description: 'Include external calls', type: 'boolean' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Call graph retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string' },
              component: { type: 'string' },
              complexity: { type: 'number' },
              isEntry: { type: 'boolean' },
              isExit: { type: 'boolean' }
            }
          }
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              type: { type: 'string' },
              count: { type: 'number' },
              isAsync: { type: 'boolean' },
              isConditional: { type: 'boolean' }
            }
          }
        }
      }
    }
  })
  async getCallGraph(
    @Param('analysisRunId') analysisRunId: string,
    @Query('depth') depth?: number,
    @Query('includeExternal') includeExternal?: boolean
  ): Promise<any> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getCallGraph(
      analysisRunId,
      depth || 10,
      includeExternal !== false
    );
  }

  @Get('entry-points/:analysisRunId')
  @ApiOperation({
    summary: 'Get entry points',
    description: 'Returns all function entry points (functions not called by others)'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Entry points retrieved successfully'
  })
  async getEntryPoints(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<any[]> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getEntryPoints(analysisRunId);
  }

  @Get('exit-points/:analysisRunId')
  @ApiOperation({
    summary: 'Get exit points',
    description: 'Returns all function exit points (functions that only call external services)'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Exit points retrieved successfully'
  })
  async getExitPoints(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<any[]> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getExitPoints(analysisRunId);
  }

  @Get('bottlenecks/:analysisRunId')
  @ApiOperation({
    summary: 'Get performance bottlenecks',
    description: 'Returns identified performance bottlenecks in the call chains'
  })
  @ApiParam({ name: 'analysisRunId', description: 'Analysis run ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bottlenecks retrieved successfully',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          function: { type: 'string' },
          reason: { type: 'string' },
          impact: { type: 'string', enum: ['low', 'medium', 'high'] },
          occurrences: { type: 'number' },
          recommendations: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  })
  async getBottlenecks(
    @Param('analysisRunId') analysisRunId: string
  ): Promise<any[]> {
    if (!analysisRunId) {
      throw new BadRequestException('Analysis run ID is required');
    }
    return this.functionCallService.getBottlenecks(analysisRunId);
  }
}