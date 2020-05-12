import VM from "@nomiclabs/ethereumjs-vm";
import { EVMResult } from "@nomiclabs/ethereumjs-vm/dist/evm/evm";
import { InterpreterStep } from "@nomiclabs/ethereumjs-vm/dist/evm/interpreter";
import Message from "@nomiclabs/ethereumjs-vm/dist/evm/message";
import { precompiles } from "@nomiclabs/ethereumjs-vm/dist/evm/precompiles";
import { BN } from "ethereumjs-util";
import { promisify } from "util";

import { getUserConfigPath } from "../../core/project-structure";
import { ErrorReporter } from "../../error-reporter/error-reporter";

import {
  CallMessageTrace,
  CreateMessageTrace,
  isCreateTrace,
  isPrecompileTrace,
  MessageTrace,
  PrecompileMessageTrace,
} from "./message-trace";

// tslint:disable only-buidler-error

const MAX_PRECOMPILE_NUMBER = Object.keys(precompiles).length + 1;
const DUMMY_RETURN_DATA = Buffer.from([]);

export class VMTracer {
  private _messageTraces: MessageTrace[] = [];
  private _enabled = false;
  private readonly _getContractCode: (address: Buffer) => Promise<Buffer>;
  private _lastError: Error | undefined;

  constructor(
    private readonly _vm: VM,
    private readonly _dontThrowErrors = false
  ) {
    const config = getUserConfigPath();
    this._beforeMessageHandler = this._beforeMessageHandler.bind(this);
    this._stepHandler = this._stepHandler.bind(this);
    this._afterMessageHandler = this._afterMessageHandler.bind(this);

    this._getContractCode = promisify(
      this._vm.stateManager.getContractCode.bind(this._vm.stateManager)
    );
  }

  public enableTracing() {
    this._vm.on("beforeMessage", this._beforeMessageHandler);
    this._vm.on("step", this._stepHandler);
    this._vm.on("afterMessage", this._afterMessageHandler);
    this._enabled = true;
  }

  public disableTracing() {
    this._vm.removeListener("beforeMessage", this._beforeMessageHandler);
    this._vm.removeListener("step", this._stepHandler);
    this._vm.removeListener("afterMessage", this._afterMessageHandler);
    this._enabled = false;
  }

  public get enabled(): boolean {
    return this._enabled;
  }

  public getLastTopLevelMessageTrace(): MessageTrace {
    if (!this._enabled) {
      throw new Error("You can't get a vm trace if the VMTracer is disabled");
    }

    if (this._messageTraces.length === 0) {
      throw new Error(
        "You can't get a vm trace if no message was executed yet"
      );
    }

    return this._messageTraces[0];
  }

  public getLastError(): Error | undefined {
    return this._lastError;
  }

  public clearLastError() {
    this._lastError = undefined;
  }

  private _shouldKeepTracing() {
    return !this._dontThrowErrors || this._lastError === undefined;
  }

  private async _beforeMessageHandler(message: Message, next: any) {
    if (!this._shouldKeepTracing()) {
      next();
      return;
    }

    try {
      let trace: MessageTrace;

      if (message.depth === 0) {
        this._messageTraces = [];
      }

      if (message.to === undefined) {
        const createTrace: CreateMessageTrace = {
          code: message.data,
          steps: [],
          value: message.value,
          returnData: DUMMY_RETURN_DATA,
          numberOfSubtraces: 0,
          depth: message.depth,
          deployedContract: undefined,
        };

        trace = createTrace;
      } else {
        const toAsBn = new BN(message.to);

        if (toAsBn.gtn(0) && toAsBn.lten(MAX_PRECOMPILE_NUMBER)) {
          const precompileTrace: PrecompileMessageTrace = {
            precompile: toAsBn.toNumber(),
            calldata: message.data,
            value: message.value,
            returnData: DUMMY_RETURN_DATA,
            depth: message.depth,
          };

          trace = precompileTrace;
        } else {
          const codeAddress =
            message._codeAddress !== undefined
              ? message._codeAddress
              : message.to;

          const code = await this._getContractCode(codeAddress);

          const callTrace: CallMessageTrace = {
            code,
            calldata: message.data,
            steps: [],
            value: message.value,
            returnData: DUMMY_RETURN_DATA,
            address: message.to,
            numberOfSubtraces: 0,
            depth: message.depth,
          };

          trace = callTrace;
        }
      }

      if (this._messageTraces.length > 0) {
        const parentTrace = this._messageTraces[this._messageTraces.length - 1];

        if (isPrecompileTrace(parentTrace)) {
          throw new Error(
            "This should not happen: message execution started while a precompile was executing"
          );
        }

        parentTrace.steps.push(trace);
        parentTrace.numberOfSubtraces += 1;
      }

      this._messageTraces.push(trace);
      next();
    } catch (error) {
      ErrorReporter.getInstance()
        .sendErrorReport(error)
        .catch(() => {}); // errorReporter send message failed unexpectedly, ignore exception
      if (this._dontThrowErrors) {
        this._lastError = error;
        next();
      } else {
        next(error);
      }
    }
  }

  private async _stepHandler(step: InterpreterStep, next: any) {
    if (!this._shouldKeepTracing()) {
      next();
      return;
    }

    try {
      const trace = this._messageTraces[this._messageTraces.length - 1];

      if (isPrecompileTrace(trace)) {
        throw new Error(
          "This should not happen: step event fired while a precompile was executing"
        );
      }

      trace.steps.push({ pc: step.pc });
      next();
    } catch (error) {
      ErrorReporter.getInstance()
        .sendErrorReport(error)
        .catch(() => {}); // errorReporter send message failed unexpectedly, ignore exception
      if (this._dontThrowErrors) {
        this._lastError = error;
        next();
      } else {
        next(error);
      }
    }
  }

  private async _afterMessageHandler(result: EVMResult, next: any) {
    if (!this._shouldKeepTracing()) {
      next();
      return;
    }

    try {
      const trace = this._messageTraces[this._messageTraces.length - 1];

      trace.error = result.execResult.exceptionError;
      trace.returnData = result.execResult.returnValue;

      if (isCreateTrace(trace)) {
        trace.deployedContract = result.createdAddress;
      }

      if (this._messageTraces.length > 1) {
        this._messageTraces.pop();
      }

      next();
    } catch (error) {
      ErrorReporter.getInstance()
        .sendErrorReport(error)
        .catch(() => {}); // errorReporter send message failed unexpectedly, ignore exception
      if (this._dontThrowErrors) {
        this._lastError = error;
        next();
      } else {
        next(error);
      }
    }
  }
}
